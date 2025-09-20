/*frontend/frontend/js/login.js

// Referencias
const loginForm = document.getElementById('loginForm');

// Mostrar / ocultar contraseña (para todos los botones .showpass)
document.addEventListener('DOMContentLoaded', () => {
  const toggleButtons = document.querySelectorAll('.showpass');
  toggleButtons.forEach(btn => {
    const input = btn.previousElementSibling; // el input está antes del botón
    btn.addEventListener('click', () => {
      const isPwd = input.type === 'password';
      input.type = isPwd ? 'text' : 'password';
      btn.textContent = isPwd ? 'Ocultar' : 'Mostrar';
    });
  });
});

// Manejar submit (SIN backend: solo redirigir)
loginForm?.addEventListener('submit', (e) => {
  e.preventDefault();

  const email = loginForm.email.value.trim();
  const password = loginForm.password.value;
  if (!email || !password) {
    alert('Por favor ingresa correo y contraseña.');
    return;
  }

  // Marcar sesión iniciada (parche temporal)
  localStorage.setItem('loggedIn', 'true');

  // ✅ Usa ruta ABSOLUTA desde la raíz del servidor de Live Server
  // (abre Live Server en la carpeta del proyecto "Hackathon")
  location.replace('/BACKEND/public/index.html');

  // Si prefieres relativo desde frontend/frontend -> BACKEND/public:
  // location.replace('../../BACKEND/public/index.html');
});
*/