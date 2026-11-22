const form = document.getElementById('init-form');
fetch('/api/init').then(r => r.json()).then(data => { if (data.initialized) location.replace('/sheets.html'); });
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch('/api/init', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({user:document.getElementById('user').value})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || '初始化失敗');
    location.replace('/sheets.html');
  } catch (error) { document.getElementById('error').textContent = error.message; button.disabled = false; }
});
