// Настройки приложения.
// 1. Создайте проект на https://supabase.com и выполните supabase/schema.sql (см. README.md).
// 2. Вставьте сюда Project URL и anon public key из Settings → API.
//    Anon key публичный по своей природе: данные защищены политиками RLS и паролем.
// Пока поля пустые, приложение работает в локальном режиме: данные хранятся
// только в этом браузере и между устройствами не синхронизируются.
window.TABEL_CONFIG = {
  SUPABASE_URL: 'https://nfquxabnfktufubbahwx.supabase.co/rest/v1/',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5mcXV4YWJuZmt0dWZ1YmJhaHd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2NjY3NDksImV4cCI6MjEwODI0Mjc0OX0.v_kwEl0ZvlyrI0WMmm9LTl2zUEfS-pkM04Zli59OXcI',

  // Логин "admin" превращается в email admin@<домен> для входа через Supabase Auth.
  // Пользователя с таким email нужно создать в Supabase: Authentication → Users → Add user.
  LOGIN_EMAIL_DOMAIN: 'tabel.app',

  // Только для локального режима (без Supabase). На опубликованном сайте с Supabase не используются.
  LOCAL_LOGIN: 'admin',
  LOCAL_PASSWORD: 'admin123'
};
