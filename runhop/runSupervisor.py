import os
import select
import signal
import subprocess
import sys
import time


stopping = False


def stop(signum, frame):
    global stopping
    stopping = True


def signal_group(pid, signum):
    try:
        os.killpg(pid, signum)
        return True
    except ProcessLookupError:
        return False


def run():
    signal.signal(signal.SIGHUP, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        child = subprocess.Popen(
            sys.argv[2:], stdin=subprocess.DEVNULL, start_new_session=True
        )
    except OSError as error:
        print("[RunHop] " + str(error), file=sys.stderr, flush=True)
        return 125
    try:
        print("\x1eRUNHOP_PID:" + sys.argv[1] + ":" + str(child.pid), file=sys.stderr, flush=True)
        while not stopping and child.poll() is None:
            readable, _, _ = select.select([0], [], [], 0.1)
            if readable and not os.read(0, 1):
                break
    finally:
        # A session owns this process group, including children that inherit it.
        if signal_group(child.pid, signal.SIGTERM):
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline and signal_group(child.pid, 0):
                child.poll()
                time.sleep(0.05)
            signal_group(child.pid, signal.SIGKILL)
        code = child.wait()
    return 128 - code if code < 0 else code


sys.exit(run())
