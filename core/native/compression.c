#include <stdint.h>
#include <string.h>
#include <zlib.h>

int32_t em_terminal_gzip(const uint8_t *input, int32_t length,
                         uint8_t *output, int32_t capacity) {
    if (length < 1024 || length > 65536 || capacity != length - 64) return 0;
    z_stream stream;
    memset(&stream, 0, sizeof(stream));
    if (deflateInit2(&stream, Z_BEST_SPEED, Z_DEFLATED, MAX_WBITS + 16,
                     8, Z_DEFAULT_STRATEGY) != Z_OK) return 0;
    stream.next_in = (Bytef *)input;
    stream.avail_in = (uInt)length;
    stream.next_out = output;
    stream.avail_out = (uInt)capacity;
    int status = deflate(&stream, Z_FINISH);
    int32_t written = status == Z_STREAM_END && stream.avail_in == 0 &&
        stream.total_out > 0 && stream.total_out <= (uLong)capacity
        ? (int32_t)stream.total_out : 0;
    if (deflateEnd(&stream) != Z_OK) return 0;
    return written;
}
