// Applies the saved theme before the page is painted. Loaded without defer, on purpose.
try {
  if (localStorage.getItem('shipkeep-theme') === 'light')
    document.documentElement.setAttribute('data-theme', 'light');
} catch {
  // Storage can be blocked: the page stays dark.
}
