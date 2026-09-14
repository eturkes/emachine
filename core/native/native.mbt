///|
pub suberror NativeError {
  NativeError(String)
}

///|
#borrow(data, out)
extern "C" fn digest_ffi(data : Bytes, len : Int, out : FixedArray[Byte]) -> Int = "em_sha256"

///|
#borrow(out)
extern "C" fn random_ffi(out : FixedArray[Byte], len : Int) -> Int = "em_random"

///|
#borrow(a, b)
extern "C" fn equal_ffi(a : Bytes, b : Bytes, len : Int) -> Int = "em_equal"

///|
pub extern "C" fn now_ms() -> Int64 = "em_now_ms"

///|
#borrow(out)
extern "C" fn hostname_ffi(out : FixedArray[Byte], len : Int) -> Int = "em_hostname"

///|
#borrow(path, out)
extern "C" fn identity_ffi(path : Bytes, out : FixedArray[Byte], len : Int) -> Int = "em_identity"

///|
#borrow(path)
extern "C" fn sync_dir_ffi(path : Bytes) -> Int = "em_sync_dir"

///|
fn check(code : Int, operation : String) -> Unit raise {
  if code != 0 { raise NativeError("\{operation}: errno \{code}") }
}

///|
fn c_string(value : String) -> Bytes {
  let bytes = @utf8.encode(value)
  let out : FixedArray[Byte] = FixedArray::make(bytes.length() + 1, 0)
  for i = 0; i < bytes.length(); i = i + 1 { out[i] = bytes[i] }
  out.unsafe_reinterpret_as_bytes()
}

///|
fn hex(data : Bytes) -> String {
  let digits = b"0123456789abcdef"
  let out : FixedArray[Byte] = FixedArray::make(data.length() * 2, 0)
  for i = 0; i < data.length(); i = i + 1 {
    let n = data[i].to_int()
    out[i * 2] = digits[n >> 4]
    out[i * 2 + 1] = digits[n & 15]
  }
  @utf8.decode_lossy(out.unsafe_reinterpret_as_bytes())
}

///|
fn from_c_string(data : FixedArray[Byte]) -> String {
  let mut length = 0
  while length < data.length() && data[length] != 0 { length = length + 1 }
  @utf8.decode_lossy(data.unsafe_reinterpret_as_bytes()[:length])
}

///|
pub fn sha256(data : Bytes) -> String raise {
  let out : FixedArray[Byte] = FixedArray::make(32, 0)
  check(digest_ffi(data, data.length(), out), "sha256")
  hex(out.unsafe_reinterpret_as_bytes())
}

///|
pub fn random_id() -> String raise {
  let out : FixedArray[Byte] = FixedArray::make(16, 0)
  check(random_ffi(out, 16), "getrandom")
  hex(out.unsafe_reinterpret_as_bytes())
}

///|
pub fn secure_equal(a : String, b : String) -> Bool {
  let x = @utf8.encode(a)
  let y = @utf8.encode(b)
  x.length() == y.length() && equal_ffi(x, y, x.length()) == 1
}

///|
pub fn hostname() -> String raise {
  let out : FixedArray[Byte] = FixedArray::make(256, 0)
  check(hostname_ffi(out, 256), "gethostname")
  from_c_string(out)
}

///|
pub fn file_identity(path : String) -> String raise {
  let out : FixedArray[Byte] = FixedArray::make(160, 0)
  check(identity_ffi(c_string(path), out, 160), "stat")
  from_c_string(out)
}

///|
pub fn sync_directory(path : String) -> Unit raise {
  check(sync_dir_ffi(c_string(path)), "fsync directory")
}

///|
#borrow(out, slave)
extern "C" fn pty_open_ffi(cols : Int, rows : Int, out : FixedArray[Int], slave : FixedArray[Byte], capacity : Int) -> Int = "em_pty_open"

///|
extern "C" fn pty_resize_ffi(fd : Int, cols : Int, rows : Int) -> Int = "em_pty_resize"

///|
pub extern "C" fn close_descriptor(fd : Int) -> Unit = "em_close_descriptor"

///|
pub fn open_pty(cols : Int, rows : Int) -> (Int, String) raise {
  let fd = FixedArray::make(1, -1)
  let slave : FixedArray[Byte] = FixedArray::make(256, 0)
  check(pty_open_ffi(cols, rows, fd, slave, 256), "open PTY")
  (fd[0], from_c_string(slave))
}

///|
pub fn resize_pty(fd : Int, cols : Int, rows : Int) -> Unit raise {
  check(pty_resize_ffi(fd, cols, rows), "resize PTY")
}
