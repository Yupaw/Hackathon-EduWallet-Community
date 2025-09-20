// Toggle mostrar/ocultar contraseña
const pass = document.getElementById('password');
const toggle = document.getElementById('togglePass');
toggle.addEventListener('click', () => {
  const show = pass.type === 'password';
  pass.type = show ? 'text' : 'password';
  toggle.textContent = show ? 'Ocultar' : 'Mostrar';
});

// Validación de intereses: exactamente 3
const boxes = Array.from(document.querySelectorAll('input[name="interests"]'));
const hint = document.getElementById('interestHint');

function updateInterests() {
  const checked = boxes.filter(b => b.checked);
  hint.textContent = `${checked.length}/3 seleccionados`;
  // Deshabilita el resto cuando ya hay 3
  if (checked.length >= 3) {
    boxes.forEach(b => { if (!b.checked) b.disabled = true; });
  } else {
    boxes.forEach(b => b.disabled = false);
  }
}
boxes.forEach(b => b.addEventListener('change', updateInterests));
updateInterests();

// Validación del formulario (solo frontend)
const form = document.getElementById('signupForm');
form.addEventListener('submit', (e) => {
  e.preventDefault();

  // Campos requeridos básicos
  if (!form.email.value.trim() ||
      !form.password.value ||
      !form.fullname.value.trim() ||
      !form.username.value.trim() ||
      !form.country.value) {
    alert('Completa todos los campos requeridos.');
    return;
  }

  // Intereses: exactamente 3
  const selected = boxes.filter(b => b.checked).map(b => b.value);
  if (selected.length !== 3) {
    alert('Selecciona exactamente 3 intereses.');
    return;
  }

  // Aquí enviarías al backend o Supabase
  const payload = {
    emailOrPhone: form.email.value.trim(),
    password: form.password.value,
    fullName: form.fullname.value.trim(),
    username: form.username.value.trim(),
    country: form.country.value,
    interests: selected
  };

  console.log('Registro listo para enviar:', payload);
  alert('¡Cuenta creada! (simulación)\nRevisa la consola para ver el payload.');
  form.reset();
  updateInterests();
});
// Limitar fecha de nacimiento: entre hace 100 años y hace 18 años
(function () {
  const birth = document.querySelector('input[name="birthdate"]');
  if (!birth) return;

  const today = new Date();
  const max = new Date(today.getFullYear() - 18, today.getMonth(), today.getDate());
  const min = new Date(today.getFullYear() - 100, today.getMonth(), today.getDate());

  const toISO = d => d.toISOString().split('T')[0];
  birth.max = toISO(max);
  birth.min = toISO(min);
})();
