# Space restore prototype (ADR-0051, step 0)

Checks whether Chrome's method still puts a window back on its macOS desktop after a quit and relaunch. Standalone; not part of the Abundio build.

```sh
./build.sh
open SpaceRestore.app --args save            # move the window to desktop 2, click Save there
# go back to desktop 1, then:
open SpaceRestore.app --args restore-plain   # control: expected to appear on desktop 1
open SpaceRestore.app --args restore         # private method: should appear on desktop 2
```

Results go to `~/.space-restore-prototype.log`. `onActiveSpace=0` means the window landed on another desktop.
