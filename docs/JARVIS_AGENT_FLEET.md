# Jarvis Agent Fleet

> Staged operating reference for the Tier 1 fleet. This is a rollout plan, not a claim that the fleet has been benchmarked or approved for expansion.

## Role and architecture

**Jarvis is the primary parallel computer pool.** Sandbar Platform and MCP are its control plane. With the default bind, MCP running on the host reaches Platform and each seat through host loopback. With an intentional Tailscale bind, configure MCP's `SANDBAR_PLATFORM_URL` with that direct tailnet dashboard address; its per-seat calls then use the same direct tailnet address. Selkies remains embedded in every desktop container for the live desktop and takeover window.

```text
MCP on Jarvis host ── loopback (default) ──> Sandbar Platform
       └────────────── loopback (default) ──> disposable or persistent seat
```

Each seat receives its own Docker bridge network. That network preserves normal outbound internet access but is not shared with another Sandbar seat. `SANDBAR_BIND_IP` defaults to `127.0.0.1`, so Platform and every desktop, chat, and control port are loopback-only by default. There are no public Sandbar ports.

For intentional remote use, set `SANDBAR_BIND_IP` to this host's Tailscale IPv4 address (`100.64.0.0/10`; the installer can detect a current valid address for that run). Platform validates that value at startup and then publishes the dashboard and every seat port directly on that tailnet address. Open the dashboard directly through that address or its tailnet host name: its generated links retain that host name and dynamically allocated port, so each seat works remotely. Tailscale authentication plus the existing Platform and per-seat tokens remain the boundary. **Do not use Tailscale Serve for the dynamic seat pool.** Tailscale Serve is an optional separate layer for one dashboard only.

## Workload lanes

- **Ordinary work:** use disposable seats. Delete them when the work ends.
- **Persistent browser profiles:** isolated, rare, and justified per seat; do not make a shared profile or convert disposable work into persistence by default.
- **Mac:** the golden-reality lane for work that requires macOS or reality checks not representable in a Linux desktop.
- **Interceptor on Linux:** explicitly unimplemented. It is a separate spike and needs its own verification before it becomes a lane.

Initial capacity is **two disposable seats and one persistent seat**. Expansion requires a resource benchmark gate, not demand alone: measure concurrent CPU, memory, process count, responsiveness, and host headroom for the intended workload before adding capacity.

## Container boundary and escalation

The initial pool uses hardened Docker containers: a distinct bridge network per seat, loopback-only published ports by default (or an intentional Tailscale-only bind), CPU and memory caps, a process limit, and `no-new-privileges`. Desktop containers receive neither host mounts nor a Docker socket. This is the normal lane, not a VM-equivalent trust boundary.

Escalate a workload when that boundary is insufficient:

1. keep routine, disposable GUI/browser work in the constrained container pool;
2. evaluate gVisor for untrusted-agent workloads that need a stronger container boundary;
3. use a VM when the workload needs a materially stronger isolation boundary or gVisor cannot satisfy its compatibility requirements.

Do not add `--privileged`, desktop Docker sockets, host mounts, or capability changes as an ad-hoc workaround. Any such change requires a separately reviewed design.

## Resource configuration

Platform startup reads these strict environment variables. Memory is bytes and CPU is a positive decimal CPU count. Invalid values stop Platform at startup instead of weakening a limit silently.

| Variable | Default | Meaning |
|---|---:|---|
| `SANDBAR_BIND_IP` | `127.0.0.1` | Host bind for Platform and every seat: exact loopback, or an intentional usable Tailscale CGNAT IPv4 address |
| `SANDBAR_COMPUTER_CPU_LIMIT` | `1` | Per-seat CPU cap |
| `SANDBAR_COMPUTER_MEMORY_LIMIT` | `2147483648` | Per-seat memory cap (2 GiB) |
| `SANDBAR_COMPUTER_PIDS_LIMIT` | `512` | Per-seat process cap |

## Staged acceptance criteria

Before treating the initial pool as ready, verify on the intended Jarvis host that:

- with the default configuration, Platform and every seat publish only loopback listeners while host MCP control still works; with a Tailscale bind, the dashboard and its dynamically allocated per-seat ports work directly from another tailnet device without Tailscale Serve;
- separate seats have distinct bridge networks, retain outbound connectivity, and cannot use a shared Sandbar network;
- configured CPU, memory, PID, and `no-new-privileges` settings appear in container inspection;
- failed creates and normal deletes remove the corresponding private network; ordinary delete retains the configuration volume and purge removes it;
- two disposable seats plus one persistent seat pass the resource benchmark gate with acceptable host headroom;
- Tailscale remote access works without adding public listeners; and
- the Mac and the unimplemented Interceptor-on-Linux lane remain outside this acceptance claim.

## Rollback

If the rollout fails, stop creating seats, return the Platform code/configuration to the prior reviewed revision, and remove only fleet containers that were created for the rollout. Preserve configuration volumes unless an operator explicitly chooses purge. Remove each affected private network after its container is gone. Do not use broad Docker prune commands: they can affect unrelated host workloads. Re-run the acceptance criteria before another expansion attempt.
