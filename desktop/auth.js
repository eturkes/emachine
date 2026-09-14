document.querySelector('#host').textContent = new URLSearchParams(location.search).get('host') ?? '';
document.querySelector('form').onsubmit = event => {
  event.preventDefault();
  const data = new FormData(event.target);
  window.gatewayLogin.submit(String(data.get('username')), String(data.get('password')));
};
document.querySelector('#cancel').onclick = () => window.gatewayLogin.cancel();
