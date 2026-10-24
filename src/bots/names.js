// Kenyan first names for bot players. First names only, so no bot reads as a
// real, well-known person.

export const KENYAN_NAMES = [
  'Wanjiru', 'Njeri', 'Wambui', 'Kamau', 'Nyambura', 'Muthoni', 'Wairimu', 'Githinji', 'Shiro',
  'Otieno', 'Akinyi', 'Achieng', 'Odhiambo', 'Atieno', 'Omondi', 'Awino', 'Adhiambo', 'Ochieng',
  'Kiptoo', 'Chebet', 'Jepkosgei', 'Cheruiyot', 'Jeptoo', 'Kibet', 'Chepkemoi', 'Jelagat', 'Chepchumba',
  'Wafula', 'Nekesa', 'Wekesa', 'Nafula', 'Barasa', 'Wanjala', 'Ayuma',
  'Mutua', 'Mumbua', 'Mwikali', 'Kioko', 'Ndinda', 'Wayua', 'Mueni', 'Mutheu',
  'Moraa', 'Kerubo', 'Nyaboke', 'Ombati', 'Kemunto',
  'Nkatha', 'Kawira', 'Gatwiri', 'Makena', 'Kendi', 'Mwende',
  'Nasieku', 'Naserian', 'Lemayian', 'Sankale', 'Leshan',
  'Ekai', 'Akai', 'Lokol',
  'Halima', 'Fatuma', 'Amina', 'Abdi', 'Mwanaisha', 'Saida', 'Juma',
  'Baraka', 'Zawadi', 'Neema', 'Imani', 'Amani', 'Furaha',
];

// Once every name is taken, names repeat with a number: "Wanjiru 2", ...
export function pickBotName(takenNames, random = Math.random) {
  const free = KENYAN_NAMES.filter((name) => !takenNames.has(name));
  if (free.length > 0) return free[Math.floor(random() * free.length)];

  const base = KENYAN_NAMES[Math.floor(random() * KENYAN_NAMES.length)];
  let n = 2;
  while (takenNames.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}
