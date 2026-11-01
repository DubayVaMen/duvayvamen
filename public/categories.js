// Tur kategoriyalari — sayt va admin panel uchun umumiy ro‘yxat.
// Har bir turga admin paneldan bir nechta kategoriya belgilanadi (tour.tags).
// Ikonkalar: 24×24, chiziqli (stroke) SVG yo‘llari.
window.CATEGORIES = [
  { id: "aqua", name: "Akvaparklar", icon: '<path d="M2 17c1.5 1.2 3 1.2 4.5 0s3-1.2 4.5 0 3 1.2 4.5 0 3-1.2 4.5 0"/><path d="M2 21c1.5 1.2 3 1.2 4.5 0s3-1.2 4.5 0 3 1.2 4.5 0 3-1.2 4.5 0"/><path d="M8 14V4a2 2 0 0 1 4 0"/><path d="M16 14V4a2 2 0 0 0-4 0"/><path d="M8 8h8M8 11.5h8"/>' },
  { id: "parks", name: "Ko‘ngilochar parklar", icon: '<circle cx="12" cy="10" r="7"/><circle cx="12" cy="10" r="1.5"/><path d="M12 3v14M5 10h14M7 5l10 10M17 5 7 15"/><path d="M8 22l4-5 4 5"/>' },
  { id: "view", name: "Kuzatuv maydonchalari", icon: '<circle cx="6.5" cy="15.5" r="3.5"/><circle cx="17.5" cy="15.5" r="3.5"/><path d="M10 15.5h4"/><path d="M3.5 13 6 5h2.5l1 6M20.5 13 18 5h-2.5l-1 6"/>' },
  { id: "tours", name: "Obzor turlari", icon: '<rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M8 3v8M16 3v8"/><circle cx="8" cy="18" r="1.6"/><circle cx="16" cy="18" r="1.6"/><path d="M6 20.5v1M18 20.5v1"/>' },
  { id: "safari", name: "Cho‘l safari", icon: '<circle cx="16" cy="7" r="3"/><path d="M16 1.5v1M21.5 7h-1M19.9 3.1l-.7.7"/><path d="M2 19c3-4 6-5 9-3s6 1.5 11-2"/><path d="M2 22h20"/>' },
  { id: "adventure", name: "Sarguzashtlar", icon: '<circle cx="12" cy="12" r="9.5"/><path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8z"/>' },
  { id: "cruise", name: "Kruizlar", icon: '<path d="M3 15h18l-2.5 5H5.5z"/><path d="M6 15v-4h12v4"/><path d="M9 11V7h6v4"/><path d="M12 7V3"/>' },
  { id: "show", name: "Shou", icon: '<path d="M4 4c5 1.5 11 1.5 16 0v7a8 8 0 0 1-16 0z"/><path d="M8.5 9.5h.01M15.5 9.5h.01"/><path d="M8.5 14c2 2 5 2 7 0"/>' },
  { id: "extreme", name: "Ekstrim", icon: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>' },
  { id: "food", name: "Gastronomiya", icon: '<path d="M6 17h12v3a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z"/><path d="M6 17a4 4 0 0 1-1.5-7.7A4.5 4.5 0 0 1 12 5.5a4.5 4.5 0 0 1 7.5 3.8A4 4 0 0 1 18 17"/>' },
  { id: "family", name: "Oilaviy dam olish", icon: '<circle cx="8" cy="7" r="3"/><circle cx="17" cy="9" r="2.3"/><path d="M2.5 20c0-3.6 2.5-6 5.5-6s5.5 2.4 5.5 6"/><path d="M13.5 15.2c.9-.8 2.1-1.2 3.5-1.2 2.6 0 4.5 2 4.5 5"/>' },
  { id: "animals", name: "Hayvonlar", icon: '<circle cx="5" cy="10" r="2"/><circle cx="9.5" cy="5.5" r="2"/><circle cx="14.5" cy="5.5" r="2"/><circle cx="19" cy="10" r="2"/><path d="M12 11c-3 0-6 4.5-6 7a3 3 0 0 0 3 3c1.2 0 2-.6 3-.6s1.8.6 3 .6a3 3 0 0 0 3-3c0-2.5-3-7-6-7z"/>' },
  { id: "culture", name: "Madaniyat va muzeylar", icon: '<path d="M3 21h18M4 18h16"/><path d="M6 18v-7M10 18v-7M14 18v-7M18 18v-7"/><path d="M3 9 12 3l9 6z"/>' },
  { id: "visa", name: "Viza va transfer", icon: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>' }
];
window.catIcon = (c, size = 26) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${c.icon}</svg>`;
