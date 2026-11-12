// Image upload: send the chosen file's bytes straight to the server.
document.querySelectorAll('form[data-upload]').forEach((form) => {
  const input = form.querySelector('input[type=file]');
  const status = form.querySelector('[data-status]');
  const button = form.querySelector('button[type=submit]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = input.files[0];
    if (!file) { status.textContent = 'Choose a JPG file first.'; return; }
    if (file.size > 8 * 1024 * 1024) { status.textContent = 'That image is over 8 MB. Export it smaller and try again.'; return; }
    button.disabled = true;
    status.textContent = 'Uploading…';
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream', 'x-csrf-token': form.dataset.csrf },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.redirect) { location.href = data.redirect; return; }
      status.textContent = data.error || 'The upload failed. Try again.';
    } catch {
      status.textContent = 'The upload failed. Check your connection and try again.';
    }
    button.disabled = false;
  });
});
