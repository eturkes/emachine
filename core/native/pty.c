#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

int em_pty_open(int32_t cols, int32_t rows, int32_t *out, uint8_t *slave, int32_t capacity) {
    if (cols < 2 || cols > 500 || rows < 2 || rows > 500) return EINVAL;
    int fd = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
    if (fd < 0) return errno;
    int rc;
    if (grantpt(fd) != 0 || unlockpt(fd) != 0) { rc = errno; close(fd); return rc; }
    rc = ptsname_r(fd, (char *)slave, (size_t)capacity);
    if (rc != 0) { close(fd); return rc; }
    struct winsize size = {.ws_col = (unsigned short)cols, .ws_row = (unsigned short)rows};
    if (ioctl(fd, TIOCSWINSZ, &size) != 0) { rc = errno; close(fd); return rc; }
    out[0] = fd;
    return 0;
}

int em_pty_resize(int32_t fd, int32_t cols, int32_t rows) {
    if (cols < 2 || cols > 500 || rows < 2 || rows > 500) return EINVAL;
    struct winsize size = {.ws_col = (unsigned short)cols, .ws_row = (unsigned short)rows};
    return ioctl(fd, TIOCSWINSZ, &size) == 0 ? 0 : errno;
}

void em_close_descriptor(int32_t fd) { if (fd >= 0) close(fd); }
