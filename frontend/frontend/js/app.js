// Datos de ejemplo (en un futuro vendrían de Supabase/API)
const courses = [
  {
    id: 1,
    title: "Introducción a HTML y CSS",
    desc: "Aprende a crear tus primeras páginas web.",
    price: 199,
    currency: "MXN",
    img: "https://images.unsplash.com/photo-1581276879432-15a19d654956?q=80&w=800"
  },
  {
    id: 2,
    title: "JavaScript Básico",
    desc: "Variables, funciones y lógica de programación.",
    price: 249,
    currency: "MXN",
    img: "https://images.unsplash.com/photo-1555066931-4365d14bab8c?q=80&w=800"
  },
  {
    id: 3,
    title: "Curso de Python",
    desc: "Automatiza tareas y aprende fundamentos de backend.",
    price: 299,
    currency: "MXN",
    img: "https://images.unsplash.com/photo-1555066931-7d3f3a0c5e43?q=80&w=800"
  }
];

// Renderizado de cursos
const container = document.getElementById("courses");
courses.forEach(c => {
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `
    <div class="card__img" style="background-image:url('${c.img}')"></div>
    <div class="card__body">
      <h3>${c.title}</h3>
      <p>${c.desc}</p>
      <div class="price">$${c.price} ${c.currency}</div>
      <button class="btn btn--brand" onclick="buyCourse(${c.id})">Comprar</button>
    </div>
  `;
  container.appendChild(card);
});

// Simular compra
function buyCourse(id) {
  const course = courses.find(c => c.id === id);
  alert(`Simulación de pago:\nHas comprado "${course.title}" por $${course.price} ${course.currency}.`);
}
