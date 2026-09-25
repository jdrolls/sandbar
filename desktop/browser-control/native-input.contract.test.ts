import { expect, test } from "bun:test";

const source = await Bun.file(new URL("./native-input.c", import.meta.url)).text();

test("native type splits permitted LF and TAB into explicit same-display keys", () => {
  expect(source).toContain("static bool type_text(xdo_t *xdo, const char *text)");
  expect(source).toContain("char chunk[MAX_TEXT_BYTES + 1]");
  expect(source).toContain("xdo_enter_text_window(xdo, CURRENTWINDOW, chunk, TEXT_KEY_DELAY_US)");
  expect(source).toContain("static bool send_type_control_key(Display *display, unsigned char character)");
  expect(source).toContain("if (character == '\\n') keysym = XK_Return;");
  expect(source).toContain("else if (character == '\\t') keysym = XK_Tab;");
  expect(source).toContain("XTestFakeKeyEvent(display, keycode, True, CurrentTime)");
  expect(source).toContain("XTestFakeKeyEvent(display, keycode, False, CurrentTime)");
  expect(source).toContain("if (!send_type_control_key(xdo->xdpy, character)) return false;");
  expect(source).toContain("if (!type_text(xdo, argv[4])) goto done;");
  expect(source).not.toContain("xdo_enter_text_window(xdo, CURRENTWINDOW, argv[4], TEXT_KEY_DELAY_US)");
});

test("native text validation keeps CR and other controls outside the LF/TAB contract", () => {
  expect(source).toContain("(character > 0x0a && character < 0x20)");
});
