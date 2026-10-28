#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
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

struct session_pty_identity {
    unsigned long long start;
    int session;
    uint32_t tty;
};

static int decimal(const char *text, unsigned long long *value) {
    if (!*text) return 0;
    for (const char *p = text; *p; p++) if (*p < '0' || *p > '9') return 0;
    errno = 0;
    char *end;
    *value = strtoull(text, &end, 10);
    return errno == 0 && *end == 0;
}

static int session_identity(int32_t pid, struct session_pty_identity *identity) {
    if (pid <= 1) return 0;
    char path[64], buffer[4096];
    snprintf(path, sizeof(path), "/proc/%d/stat", pid);
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return 0;
    struct stat info;
    ssize_t count = -1;
    if (fstat(fd, &info) == 0 && info.st_uid == getuid())
        count = read(fd, buffer, sizeof(buffer) - 1);
    close(fd);
    if (count <= 0 || count == sizeof(buffer) - 1) return 0;
    buffer[count] = 0;
    char *pid_end;
    errno = 0;
    long actual_pid = strtol(buffer, &pid_end, 10);
    if (errno || actual_pid != pid || pid_end[0] != ' ' || pid_end[1] != '(') return 0;
    char *end = strrchr(buffer, ')');
    if (!end || end[1] != ' ') return 0;
    char *save = NULL, *token = strtok_r(end + 2, " \n", &save);
    if (!token || strlen(token) != 1 || strchr("ZXx", token[0])) return 0;
    struct session_pty_identity found = {0};
    for (int field = 4; field <= 22; field++) {
        token = strtok_r(NULL, " \n", &save);
        if (!token) return 0;
        if (field == 6) {
            unsigned long long session;
            if (!decimal(token, &session) || !session || session > INT_MAX) return 0;
            found.session = (int)session;
        } else if (field == 7) {
            errno = 0;
            char *tty_end;
            long long tty = strtoll(token, &tty_end, 10);
            if (errno || *tty_end || tty < INT32_MIN || tty > INT32_MAX || !tty) return 0;
            found.tty = (uint32_t)tty;
        } else if (field == 22 && !decimal(token, &found.start)) return 0;
    }
    *identity = found;
    return 1;
}

static int format_session_identity(const struct session_pty_identity *identity, char *out, size_t capacity) {
    int n = snprintf(out, capacity, "%llu:%d:%u", identity->start, identity->session, identity->tty);
    return n > 0 && (size_t)n < capacity;
}

int em_session_pty_identity(int32_t pid, uint8_t *out, int32_t capacity) {
    if (capacity <= 0) return 0;
    struct session_pty_identity identity;
    return session_identity(pid, &identity) &&
        format_session_identity(&identity, (char *)out, (size_t)capacity);
}

int em_session_pty_size(int32_t pid, const uint8_t *expected, int32_t *out) {
    struct session_pty_identity before, after;
    char identity[96];
    if (!expected[0] || strnlen((const char *)expected, sizeof(identity)) >= sizeof(identity) ||
        !session_identity(pid, &before) ||
        !format_session_identity(&before, identity, sizeof(identity)) ||
        strcmp(identity, (const char *)expected)) return 0;
    dev_t device = makedev((before.tty >> 8) & 0xfff,
                          (before.tty & 0xff) | ((before.tty >> 12) & 0xfff00));
    for (int stream = 0; stream < 3; stream++) {
        char path[64];
        snprintf(path, sizeof(path), "/proc/%d/fd/%d", pid, stream);
        struct stat candidate, opened;
        if (stat(path, &candidate) != 0 || !S_ISCHR(candidate.st_mode) ||
            candidate.st_rdev != device || candidate.st_uid != getuid()) continue;
        int fd = open(path, O_RDONLY | O_NONBLOCK | O_NOCTTY | O_CLOEXEC);
        if (fd < 0) continue;
        struct winsize size;
        int okay = fstat(fd, &opened) == 0 && S_ISCHR(opened.st_mode) &&
            opened.st_rdev == device && opened.st_uid == getuid() &&
            opened.st_dev == candidate.st_dev && opened.st_ino == candidate.st_ino &&
            ioctl(fd, TIOCGWINSZ, &size) == 0;
        // Keeping a slave descriptor open would prevent normal PTY hangup after shell exit.
        close(fd);
        if (!okay || size.ws_col < 2 || size.ws_col > 500 || size.ws_row < 2 || size.ws_row > 500) continue;
        if (!session_identity(pid, &after) ||
            !format_session_identity(&after, identity, sizeof(identity)) ||
            strcmp(identity, (const char *)expected)) return 0;
        out[0] = size.ws_col;
        out[1] = size.ws_row;
        return 1;
    }
    return 0;
}
