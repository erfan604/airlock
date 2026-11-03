#!/usr/bin/env python3
"""Pre-lock capture helper: run a real command in a pty and save its output chunks with timestamps as JSON.
Usage: video-term-record.py <out.json> -- <shell command>
The command runs with a clean prompt-free environment line; nothing is echoed except what the command prints."""
import json, os, pty, select, sys, time
out = sys.argv[1]
cmd = sys.argv[sys.argv.index('--') + 1]
chunks = []
t0 = time.time()
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.environ['COLUMNS'] = '110'
    os.environ['FORCE_COLOR'] = '1'
    os.execvp('/bin/bash', ['bash', '-c', cmd])
import fcntl, struct, termios
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 110, 0, 0))
while True:
    r, _, _ = select.select([fd], [], [], 0.5)
    if r:
        try:
            d = os.read(fd, 65536)
        except OSError:
            break
        if not d:
            break
        chunks.append({'t': round(time.time() - t0, 3), 'd': d.decode('utf8', 'replace')})
    else:
        try:
            if os.waitpid(pid, os.WNOHANG)[0]:
                break
        except ChildProcessError:
            break
json.dump({'cmd_seconds': round(time.time() - t0, 1), 'chunks': chunks}, open(out, 'w'))
print('recorded', len(chunks), 'chunks', round(time.time() - t0, 1), 's')
