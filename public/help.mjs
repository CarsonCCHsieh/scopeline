import { applyTranslations, setLanguage } from './i18n.mjs';
applyTranslations();
document.getElementById('language').addEventListener('change', event => setLanguage(event.target.value));
