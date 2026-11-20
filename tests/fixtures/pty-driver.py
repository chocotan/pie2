"""Drive the real CLI through a PTY; only emit compact JSON observations."""
import codecs
import fcntl
import json
import os
import pty
import re
import selectors
import signal
import struct
import subprocess
import sys
import termios
import time


ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])")


def interrupted(_signum, _frame):
    raise SystemExit("PTY driver interrupted")


def run(spec):
    master, slave = pty.openpty()
    initial = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    selector = selectors.DefaultSelector()
    child = None
    output = ""
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    deadline = time.monotonic() + 10
    observed = []
    raw_seen = False

    def read_output(timeout):
        nonlocal output
        for _key, _events in selector.select(timeout):
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if data:
                output += decoder.decode(data)
            else:
                selector.unregister(master)

    try:
        child = subprocess.Popen(
            spec["argv"], cwd=spec["cwd"], env=dict(os.environ),
            stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
        )
        selector.register(master, selectors.EVENT_READ)
        checkpoint = 0
        for step in spec["steps"]:
            if "send" in step:
                checkpoint = len(output)
                os.write(master, step["send"].encode())
            expected = step.get("wait")
            if expected is None:
                continue
            while expected not in ANSI.sub("", output[checkpoint:]):
                if time.monotonic() >= deadline:
                    raise AssertionError(f"Timed out waiting for {expected!r}")
                read_output(min(0.2, max(0, deadline - time.monotonic())))
                if child.poll() is not None and expected not in ANSI.sub("", output[checkpoint:]):
                    raise AssertionError(f"CLI exited {child.returncode} while waiting for {expected!r}")
            observed.append(expected)
            flags = termios.tcgetattr(slave)[3]
            raw_seen |= not bool(flags & (termios.ICANON | termios.ECHO))
        while child.poll() is None:
            if time.monotonic() >= deadline:
                raise AssertionError("CLI did not exit after /exit")
            read_output(min(0.2, max(0, deadline - time.monotonic())))
        read_output(0)
        restored = termios.tcgetattr(slave) == initial
        assert child.returncode == 0, f"CLI exited {child.returncode}"
        assert raw_seen, "CLI never entered terminal raw mode"
        assert restored, "CLI did not restore terminal attributes"
        assert "\x1b[?1049l" in output, "CLI did not leave the alternate screen"
        return {"code": child.returncode, "observed": observed, "rawSeen": raw_seen, "restored": restored}
    except Exception as error:
        raise AssertionError(f"{error}\nLast terminal output:\n{ANSI.sub('', output)[-4000:]}") from error
    finally:
        if child is not None:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        selector.close()
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    try:
        print(json.dumps(run(json.load(sys.stdin))))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
