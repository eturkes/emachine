///|
pub fn authorized(config : @model.Config, headers : @http.Headers, require_origin : Bool) -> Bool {
  let origin = headers.get("Origin")
  match origin {
    Some(value) if !config.allowedOrigins.contains(value) => return false
    None if require_origin => return false
    _ => ()
  }
  if headers.get("X-Emachine-Gateway") is Some(token) {
    return !config.gatewaySecret.is_empty() && @native.secure_equal(token, config.gatewaySecret)
  }
  if headers.get("Tailscale-User-Login") is Some(user) {
    return config.allowedUsers.contains(user)
  }
  if headers.contains("X-Forwarded-For") || headers.contains("Forwarded") || headers.contains("X-Forwarded-Proto") {
    return false
  }
  let host = headers.get("Host").unwrap_or("")
  host == "127.0.0.1:\{config.port}" || host == "localhost:\{config.port}" || host == "[::1]:\{config.port}"
}

///|
pub fn valid_revision(value : String) -> Bool {
  if value.length() != 64 { return false }
  for byte in @utf8.encode(value) {
    let n = byte.to_int()
    if !((n >= 48 && n <= 57) || (n >= 97 && n <= 102)) { return false }
  }
  true
}

///|
pub fn dimension(query : String, key : String, fallback : Int) -> Int {
  for piece in query.split("&") {
    if piece.split_once("=") is Some((name, value)) && name == key {
      if value.length() > 3 || value.is_empty() { return fallback }
      let mut result = 0
      for byte in @utf8.encode(value) {
        let n = byte.to_int()
        if n < 48 || n > 57 { return fallback }
        result = result * 10 + n - 48
      }
      return if result >= 2 && result <= 500 { result } else { fallback }
    }
  }
  fallback
}

///|
fn response_headers(config : @model.Config, request : @http.Request) -> @http.Headers {
  let headers : @http.Headers = {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "Vary": "Origin",
  }
  if request.headers.get("Origin") is Some(origin) && config.allowedOrigins.contains(origin) {
    headers["Access-Control-Allow-Origin"] = origin
    headers["Access-Control-Allow-Credentials"] = "true"
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    headers["Access-Control-Allow-Headers"] = "Content-Type"
  }
  headers
}

///|
async fn bounded_read(reader : &@io.Reader, limit : Int) -> Bytes {
  let chunks : Array[Bytes] = []
  let mut length = 0
  for ;; {
    match reader.read_some(max_len=16384) {
      None => break
      Some(bytes) => {
        length = length + bytes.length()
        if length > limit { fail("Request exceeds its size limit") }
        chunks.push(bytes)
      }
    }
  }
  let result : FixedArray[Byte] = FixedArray::make(length, 0)
  let mut offset = 0
  for bytes in chunks {
    FixedArray::blit_from_bytes(result, offset, bytes, 0, bytes.length())
    offset = offset + bytes.length()
  }
  result.unsafe_reinterpret_as_bytes()
}
