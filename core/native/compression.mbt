///|
#borrow(data, out)
extern "C" fn terminal_gzip_ffi(
  data : Bytes,
  length : Int32,
  out : FixedArray[Byte],
  capacity : Int32,
) -> Int32 = "em_terminal_gzip"

///|
/// Independent bounded gzip members keep reconnect checkpoints and raw fallback exact.
pub fn terminal_gzip(data : Bytes) -> Bytes? {
  if data.length() < 1024 || data.length() > 65536 {
    return None
  }
  let out = FixedArray::make(data.length() - 64, b'\x00')
  let written = terminal_gzip_ffi(data, data.length(), out, out.length())
  if written <= 0 || written > out.length() {
    None
  } else {
    Some(out.unsafe_reinterpret_as_bytes()[:written].to_owned())
  }
}
