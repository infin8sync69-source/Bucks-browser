document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('ephemeral-input');

  // Handle Enter key and Escape key
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const query = input.value.trim();
      if (query) {
        await window.ephemeralAPI.submitQuery(query);
        input.value = ''; // clear for next time
      }
    } else if (e.key === 'Escape') {
      window.ephemeralAPI.hide();
      input.value = ''; // clear
    }
  });

  // Focus input when window is shown
  window.ephemeralAPI.onFocusInput(() => {
    input.focus();
    input.select();
  });
});
