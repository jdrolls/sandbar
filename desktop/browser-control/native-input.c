/*
 * Internal Sandbar native-input primitive.  This is deliberately not a CLI
 * capability: bridge.ts supplies every argument from private ownership state.
 */
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/keysym.h>
#include <X11/extensions/XTest.h>
#include <xdo.h>

#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>

#define MAX_TEXT_BYTES 4096
#define MAX_COORDINATE 7680
#define MAX_SCROLL 100
#define TEXT_KEY_DELAY_US 1
#define MAX_POINTER_CHAIN_DEPTH 64

static int saw_x_error = 0;

static int remember_x_error(Display *display, XErrorEvent *event) {
  (void)display;
  (void)event;
  saw_x_error = 1;
  return 0;
}

static bool decimal_id(const char *value, uint32_t *result) {
  char *end = NULL;
  unsigned long long parsed;
  if (value == NULL || *value == '\0') return false;
  for (const char *cursor = value; *cursor != '\0'; cursor++) {
    if (*cursor < '0' || *cursor > '9') return false;
  }
  errno = 0;
  parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == NULL || *end != '\0' || parsed == 0 || parsed > UINT32_MAX) return false;
  *result = (uint32_t)parsed;
  return true;
}

static bool bounded_integer(const char *value, int minimum, int maximum, int *result) {
  char *end = NULL;
  long parsed;
  if (value == NULL || *value == '\0') return false;
  errno = 0;
  parsed = strtol(value, &end, 10);
  if (errno != 0 || end == NULL || *end != '\0' || parsed < minimum || parsed > maximum) return false;
  *result = (int)parsed;
  return true;
}

static bool valid_text(const char *text) {
  size_t length;
  if (text == NULL || *text == '\0') return false;
  length = strlen(text);
  if (length > MAX_TEXT_BYTES) return false;
  for (size_t index = 0; index < length; index++) {
    unsigned char character = (unsigned char)text[index];
    if (character == 0 || character < 0x09 || (character > 0x0a && character < 0x20) || character == 0x7f) return false;
  }
  return true;
}

static bool allowed_key(const char *key) {
  static const char *const keys[] = {
      "BackSpace", "Delete", "Left", "Right", "Up", "Down", "Home", "End", "Return", "Tab"};
  for (size_t index = 0; index < sizeof(keys) / sizeof(keys[0]); index++) {
    if (strcmp(key, keys[index]) == 0) return true;
  }
  return false;
}

static bool send_type_control_key(Display *display, unsigned char character) {
  KeySym keysym;
  KeyCode keycode;

  /* Type payloads may use only these two controls. Keep this allowlist local
   * to the split path so a future caller cannot turn arbitrary text into a
   * key sequence while the server is grabbed. */
  if (character == '\n') keysym = XK_Return;
  else if (character == '\t') keysym = XK_Tab;
  else return false;
  keycode = XKeysymToKeycode(display, keysym);
  if (keycode == 0) return false;
  return XTestFakeKeyEvent(display, keycode, True, CurrentTime) != 0 &&
         XTestFakeKeyEvent(display, keycode, False, CurrentTime) != 0;
}

static bool type_text(xdo_t *xdo, const char *text) {
  char chunk[MAX_TEXT_BYTES + 1];
  size_t chunk_length = 0;
  size_t length = strlen(text);

  /* libxdo drops embedded LF from text entry. Split only the two controls
   * valid_text permits, emit ordinary bytes through libxdo, and synthesize
   * their explicit allowlisted XTEST equivalents on this same xdo Display. */
  for (size_t index = 0; index <= length; index++) {
    unsigned char character = (unsigned char)text[index];
    if (character != '\n' && character != '\t' && character != '\0') {
      if (chunk_length >= MAX_TEXT_BYTES) return false;
      chunk[chunk_length++] = (char)character;
      continue;
    }
    if (chunk_length > 0) {
      chunk[chunk_length] = '\0';
      if (xdo_enter_text_window(xdo, CURRENTWINDOW, chunk, TEXT_KEY_DELAY_US) != XDO_SUCCESS) return false;
      chunk_length = 0;
    }
    if (character == '\0') return true;
    if (!send_type_control_key(xdo->xdpy, character)) return false;
  }
  return false;
}

static bool window_has_expected_pid(Display *display, Window window, uint32_t expected_pid) {
  Atom pid_atom = XInternAtom(display, "_NET_WM_PID", True);
  Atom actual_type = None;
  int actual_format = 0;
  unsigned long item_count = 0;
  unsigned long bytes_after = 0;
  unsigned char *property = NULL;
  bool matches = false;

  if (pid_atom == None) return false;
  if (XGetWindowProperty(display, window, pid_atom, 0, 1, False, XA_CARDINAL,
                         &actual_type, &actual_format, &item_count, &bytes_after,
                         &property) != Success) {
    return false;
  }
  if (actual_type == XA_CARDINAL && actual_format == 32 && item_count == 1 && bytes_after == 0 && property != NULL) {
    /* Xlib stores 32-bit property values in unsigned long slots. */
    matches = ((unsigned long *)property)[0] == (unsigned long)expected_pid;
  }
  if (property != NULL) XFree(property);
  return matches;
}

static bool focus_is_window_or_descendant(Display *display, Window focus, Window expected) {
  Window current = focus;
  for (unsigned int depth = 0; depth < 64 && current != None && current != PointerRoot; depth++) {
    Window root = None;
    Window parent = None;
    Window *children = NULL;
    unsigned int child_count = 0;
    if (current == expected) return true;
    if (!XQueryTree(display, current, &root, &parent, &children, &child_count)) return false;
    if (children != NULL) XFree(children);
    if (parent == expected) return true;
    if (parent == None || parent == current) return false;
    current = parent;
  }
  return false;
}

static bool focus_belongs_to(Display *display, Window expected) {
  Window focus = None;
  int revert_to = RevertToNone;
  XGetInputFocus(display, &focus, &revert_to);
  if (focus == None || focus == PointerRoot) return false;
  return focus_is_window_or_descendant(display, focus, expected);
}

static bool expected_window_contains_point(Display *display, Window expected, int point_x,
                                           int point_y, Window *root_out) {
  Window root = None;
  Window unused_child = None;
  int unused_x = 0;
  int unused_y = 0;
  int root_x = 0;
  int root_y = 0;
  unsigned int width = 0;
  unsigned int height = 0;
  unsigned int unused_border = 0;
  unsigned int unused_depth = 0;

  if (!XGetGeometry(display, expected, &root, &unused_x, &unused_y, &width, &height,
                    &unused_border, &unused_depth) || root == None || width == 0 || height == 0) {
    return false;
  }
  /* XGetGeometry reports coordinates relative to a parent. Translate the
   * current window origin to its root so reparenting cannot bypass bounds. */
  if (!XTranslateCoordinates(display, expected, root, 0, 0, &root_x, &root_y, &unused_child)) return false;
  if ((int64_t)point_x < (int64_t)root_x || (int64_t)point_y < (int64_t)root_y ||
      (int64_t)point_x >= (int64_t)root_x + (int64_t)width ||
      (int64_t)point_y >= (int64_t)root_y + (int64_t)height) {
    return false;
  }
  *root_out = root;
  return true;
}

static bool pointer_target_is_in_expected_window(Display *display, Window root,
                                                  Window expected, int point_x, int point_y) {
  Window current = root;
  bool expected_seen = false;

  /* Follow the server's current pointer child chain rather than trusting the
   * pre-grab Node geometry. A foreign overlay is rejected before any button
   * event can be synthesized. */
  for (unsigned int depth = 0; depth < MAX_POINTER_CHAIN_DEPTH; depth++) {
    Window returned_root = None;
    Window child = None;
    int root_x = 0;
    int root_y = 0;
    int window_x = 0;
    int window_y = 0;
    unsigned int mask = 0;

    if (current == expected) expected_seen = true;
    if (!XQueryPointer(display, current, &returned_root, &child, &root_x, &root_y,
                       &window_x, &window_y, &mask)) {
      return false;
    }
    if (current == root && (returned_root != root || root_x != point_x || root_y != point_y)) return false;
    if (child == None) return expected_seen;
    if (child == current) return false;
    current = child;
  }
  return false;
}

static bool prepare_pointer_input(xdo_t *xdo, Display *display, Window expected,
                                  int point_x, int point_y) {
  Window root = None;

  /* All rejections occur before xdo_click_window: no fallback input path is
   * permitted when geometry, focus, or the actual pointer target is unsafe. */
  if (!expected_window_contains_point(display, expected, point_x, point_y, &root) || saw_x_error) return false;
  if (xdo_move_mouse(xdo, point_x, point_y, 0) != XDO_SUCCESS) return false;
  XSync(display, False);
  if (saw_x_error || !focus_belongs_to(display, expected)) return false;
  if (!pointer_target_is_in_expected_window(display, root, expected, point_x, point_y)) return false;
  XSync(display, False);
  return !saw_x_error;
}

static bool enable_parent_death_signal(void) {
  pid_t parent = getppid();

  /* A parent can exit after getppid() and before PR_SET_PDEATHSIG. Re-read
   * afterward so this helper never continues orphaned during that race. */
  if (parent <= 1 || prctl(PR_SET_PDEATHSIG, SIGTERM) != 0) return false;
  return getppid() == parent && parent > 1;
}

int main(int argc, char **argv) {
  uint32_t expected_xid;
  uint32_t expected_pid;
  xdo_t *xdo = NULL;
  Display *display = NULL;
  XErrorHandler previous_handler = NULL;
  bool error_handler_installed = false;
  bool grabbed = false;
  int status = 1;
  Window expected;

  if (!enable_parent_death_signal()) return 1;
  if (argc < 5 || !decimal_id(argv[1], &expected_xid) || !decimal_id(argv[2], &expected_pid) || expected_pid > INT_MAX) return 2;
  expected = (Window)expected_xid;
  if ((strcmp(argv[3], "type") == 0 && (argc != 5 || !valid_text(argv[4]))) ||
      (strcmp(argv[3], "key") == 0 && (argc != 5 || !allowed_key(argv[4]))) ||
      (strcmp(argv[3], "click") == 0 && (argc != 6 || !bounded_integer(argv[4], 0, MAX_COORDINATE, &(int){0}) || !bounded_integer(argv[5], 0, MAX_COORDINATE, &(int){0}))) ||
      (strcmp(argv[3], "scroll") == 0 && (argc != 8 || !bounded_integer(argv[4], 0, MAX_COORDINATE, &(int){0}) || !bounded_integer(argv[5], 0, MAX_COORDINATE, &(int){0}) || !bounded_integer(argv[6], -MAX_SCROLL, MAX_SCROLL, &(int){0}) || !bounded_integer(argv[7], -MAX_SCROLL, MAX_SCROLL, &(int){0}))) ||
      (strcmp(argv[3], "click") != 0 && strcmp(argv[3], "scroll") != 0 &&
       strcmp(argv[3], "type") != 0 && strcmp(argv[3], "key") != 0)) return 2;

  xdo = xdo_new(":1");
  if (xdo == NULL || xdo->xdpy == NULL) goto done;
  display = xdo->xdpy;
  previous_handler = XSetErrorHandler(remember_x_error);
  error_handler_installed = true;
  XGrabServer(display);
  grabbed = true;

  /* The guard and XTEST requests share this xdo Display while the server is
   * grabbed, so another client cannot steal focus between verification/input. */
  if (!window_has_expected_pid(display, expected, expected_pid) || !focus_belongs_to(display, expected)) goto done;
  XSync(display, False);
  if (saw_x_error) goto done;

  if (strcmp(argv[3], "type") == 0) {
    if (!type_text(xdo, argv[4])) goto done;
  } else if (strcmp(argv[3], "key") == 0) {
    if (xdo_send_keysequence_window(xdo, CURRENTWINDOW, argv[4], 0) != XDO_SUCCESS) goto done;
  } else if (strcmp(argv[3], "click") == 0) {
    int x, y;
    if (argc != 6 || !bounded_integer(argv[4], 0, MAX_COORDINATE, &x) || !bounded_integer(argv[5], 0, MAX_COORDINATE, &y)) { status = 2; goto done; }
    if (!prepare_pointer_input(xdo, display, expected, x, y)) goto done;
    if (xdo_click_window(xdo, CURRENTWINDOW, 1) != XDO_SUCCESS) goto done;
  } else { /* scroll */
    int x, y, horizontal, vertical;
    if (argc != 8 || !bounded_integer(argv[4], 0, MAX_COORDINATE, &x) || !bounded_integer(argv[5], 0, MAX_COORDINATE, &y) ||
        !bounded_integer(argv[6], -MAX_SCROLL, MAX_SCROLL, &horizontal) || !bounded_integer(argv[7], -MAX_SCROLL, MAX_SCROLL, &vertical)) { status = 2; goto done; }
    if (!prepare_pointer_input(xdo, display, expected, x, y)) goto done;
    for (int index = 0; index < abs(horizontal); index++) {
      if (xdo_click_window(xdo, CURRENTWINDOW, horizontal > 0 ? 7 : 6) != XDO_SUCCESS) goto done;
    }
    for (int index = 0; index < abs(vertical); index++) {
      if (xdo_click_window(xdo, CURRENTWINDOW, vertical > 0 ? 5 : 4) != XDO_SUCCESS) goto done;
    }
  }
  status = 0;

done:
  if (display != NULL && grabbed) {
    /* Flush XTEST before releasing the focus guard, including failure paths. */
    XSync(display, False);
    if (saw_x_error) status = 1;
    XUngrabServer(display);
    XFlush(display);
  }
  if (error_handler_installed) XSetErrorHandler(previous_handler);
  if (xdo != NULL) xdo_free(xdo);
  return status;
}
