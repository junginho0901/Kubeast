// Sets the colour mode before the first paint (src/utils/colorMode.ts keeps it after that). A file, not an inline
// script: the gateway's CSP allows scripts from 'self' only.
try {
  var mode = localStorage.getItem('kubeast.colorMode')
  if (mode === 'dark' || mode === 'light') document.documentElement.dataset.colorMode = mode
} catch (e) {
  /* storage blocked: the default */
}
