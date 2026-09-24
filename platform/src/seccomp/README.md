# Docker seccomp provenance

`docker-default.json` is an unmodified vendored copy of Moby Profiles'
`seccomp/default.json` at commit
[`245180c51918481c0525424b3ee025d2b435d46c`](https://github.com/moby/profiles/tree/245180c51918481c0525424b3ee025d2b435d46c),
Git blob `77df9d19e844f4403e41e401aca25ab28861e317`.

The source is licensed under Apache-2.0; its license is vendored beside the
baseline. `browser-sandbox.ts` treats the JSON as immutable and copies it
before appending exactly five `SCMP_ACT_ALLOW` rules for Chromium's proven
namespace setup. The Docker API receives that generated copy inline as a
`seccomp=<JSON>` security option; no host path or caller-provided profile is
accepted.
