#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <openssl/crypto.h>
#include <openssl/sha.h>

int em_sha256(const uint8_t *data, int32_t len, uint8_t *out) {
    return SHA256(data, (size_t)len, out) ? 0 : EIO;
}

int em_random(uint8_t *out, int32_t len) {
    int32_t done = 0;
    while (done < len) {
        ssize_t n = getrandom(out + done, (size_t)(len - done), 0);
        if (n < 0) { if (errno == EINTR) continue; return errno; }
        if (n == 0) return EIO;
        done += (int32_t)n;
    }
    return 0;
}

int em_equal(const uint8_t *a, const uint8_t *b, int32_t len) {
    return CRYPTO_memcmp(a, b, (size_t)len) == 0;
}

int64_t em_now_ms(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_REALTIME, &t) != 0) return 0;
    return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

int em_hostname(uint8_t *out, int32_t len) {
    if (gethostname((char *)out, (size_t)len) != 0) return errno;
    out[len - 1] = 0;
    return 0;
}

int em_identity(const uint8_t *path, uint8_t *out, int32_t len) {
    struct stat st;
    if (stat((const char *)path, &st) != 0) return errno;
    struct statx sx;
    int64_t born = 0;
    uint32_t nanos = 0;
    if (statx(AT_FDCWD, (const char *)path, 0, STATX_BTIME, &sx) == 0 && (sx.stx_mask & STATX_BTIME)) {
        born = sx.stx_btime.tv_sec;
        nanos = sx.stx_btime.tv_nsec;
    }
    int n = snprintf((char *)out, (size_t)len, "%llu:%llu:%lld:%u",
                     (unsigned long long)st.st_dev, (unsigned long long)st.st_ino,
                     (long long)born, nanos);
    return n < 0 || n >= len ? ENAMETOOLONG : 0;
}

int em_sync_dir(const uint8_t *path) {
    int fd = open((const char *)path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) return errno;
    int rc = fsync(fd) == 0 ? 0 : errno;
    close(fd);
    return rc;
}

/* Session records can outlive their process. Match the kernel birth stamp,
   owner and PID domain, not kill(pid, 0) or an age-based activity timeout. */
int em_process_matches(int32_t pid, const uint8_t *start, const uint8_t *domain) {
    if (pid <= 1 || !start[0]) return 0;
    for (const uint8_t *p = start; *p; p++) if (*p < '0' || *p > '9') return 0;
    char path[64], buffer[4096];
    snprintf(path, sizeof(path), "/proc/%d/stat", pid);
    FILE *file = fopen(path, "re");
    if (!file) return 0;
    struct stat info;
    int owned = fstat(fileno(file), &info) == 0 && info.st_uid == getuid();
    int read = owned && fgets(buffer, sizeof(buffer), file) != NULL;
    fclose(file);
    if (!read) return 0;
    char *end = strrchr(buffer, ')');
    if (!end || end[1] != ' ') return 0;
    char *save = NULL, *token = strtok_r(end + 2, " \n", &save);
    if (!token || token[0] == 'Z' || token[0] == 'X') return 0;
    for (int field = 4; field <= 22 && token; field++) token = strtok_r(NULL, " \n", &save);
    if (!token || strcmp(token, (const char *)start) != 0) return 0;
    if (domain[0]) {
        char machine[64], ns[64], expected[160];
        file = fopen("/etc/machine-id", "re");
        if (!file) return 0;
        read = fgets(machine, sizeof(machine), file) != NULL;
        fclose(file);
        if (!read) return 0;
        machine[strcspn(machine, "\r\n")] = 0;
        ssize_t n = readlink("/proc/self/ns/pid", ns, sizeof(ns) - 1);
        if (n < 0) return 0;
        ns[n] = 0;
        snprintf(expected, sizeof(expected), "linux:%s:%s", machine, ns);
        if (strcmp(expected, (const char *)domain) != 0) return 0;
    }
    return 1;
}
