/** @type {Array<{id:string, name:string, brand:string, price:number, oldPrice:number, discount:number, imageUrl:string, productUrl:string, category:string, rating:number, reviewsCount:number, scrapedAt:string}>} */
let allProducts = [];

const searchInput = document.getElementById("search");
const categoryFilter = document.getElementById("category-filter");
const minDiscountInput = document.getElementById("min-discount");
const discountValueLabel = document.getElementById("discount-value");
const sortSelect = document.getElementById("sort");
const productsGrid = document.getElementById("products");
const loadingEl = document.getElementById("loading");
const emptyStateEl = document.getElementById("empty-state");
const updateTimeEl = document.getElementById("update-time");
const totalCountEl = document.getElementById("total-count");
const filteredCountEl = document.getElementById("filtered-count");
const maxDiscountEl = document.getElementById("max-discount");
const categoryCountEl = document.getElementById("category-count");
const statsRow = document.getElementById("stats-row");
const totalCountLabel = document.getElementById("total-count-label");

function formatPrice(value) {
  return new Intl.NumberFormat("ru-BY", {
    style: "currency",
    currency: "BYN",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDate(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  return d.toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

function createProductCard(product) {
  const card = document.createElement("a");
  card.className = "product-card";
  card.href = product.productUrl;
  card.target = "_blank";
  card.rel = "noopener noreferrer";

  const imgSrc = product.imageUrl || "";
  const placeholderSvg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 400'%3E%3Crect fill='%23f7f7f7' width='300' height='400'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='.3em' fill='%23ccc' font-size='14' font-family='sans-serif'%3E%D0%9D%D0%B5%D1%82%20%D1%84%D0%BE%D1%82%D0%BE%3C/text%3E%3C/svg%3E";

  const ratingHtml = product.rating > 0
    ? `<div class="product-rating"><span class="star">\u2605</span> ${product.rating.toFixed(1)}${product.reviewsCount ? ` (${product.reviewsCount})` : ""}</div>`
    : "";

  card.innerHTML = `
    <div class="product-image">
      <img src="${imgSrc || placeholderSvg}" alt="${escapeHtml(product.name)}" loading="lazy" onerror="this.src='${placeholderSvg}'" />
      <div class="badge-row">
        <span class="discount-badge">&minus;${product.discount}%</span>
      </div>
    </div>
    <div class="product-info">
      <span class="product-brand">${escapeHtml(product.brand)}</span>
      <span class="product-name">${escapeHtml(product.name)}</span>
      <span class="product-category">${escapeHtml(product.category)}</span>
      <div class="product-prices">
        <span class="price-current">${formatPrice(product.price)}</span>
        <span class="price-old">${formatPrice(product.oldPrice)}</span>
      </div>
      ${ratingHtml}
    </div>
  `;

  return card;
}

function getFilteredProducts() {
  const search = searchInput.value.toLowerCase().trim();
  const category = categoryFilter.value;
  const minDiscount = parseInt(minDiscountInput.value, 10);
  const sort = sortSelect.value;

  let filtered = allProducts.filter((p) => {
    if (category && p.category !== category) return false;
    if (p.discount < minDiscount) return false;
    if (search) {
      const haystack = `${p.name} ${p.brand}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    switch (sort) {
      case "discount-desc": return b.discount - a.discount;
      case "price-asc": return a.price - b.price;
      case "price-desc": return b.price - a.price;
      case "name-asc": return a.name.localeCompare(b.name, "ru");
      default: return 0;
    }
  });

  return filtered;
}

function renderProducts() {
  const filtered = getFilteredProducts();
  productsGrid.innerHTML = "";

  filteredCountEl.textContent = filtered.length;

  if (filtered.length === 0 && allProducts.length > 0) {
    emptyStateEl.style.display = "flex";
    emptyStateEl.querySelector("h3").textContent = "Ничего не найдено";
    emptyStateEl.querySelector("p").textContent = "Попробуйте изменить фильтры.";
    productsGrid.style.display = "none";
  } else {
    emptyStateEl.style.display = "none";
    productsGrid.style.display = "grid";
    const fragment = document.createDocumentFragment();
    for (const p of filtered) {
      fragment.appendChild(createProductCard(p));
    }
    productsGrid.appendChild(fragment);
  }
}

function populateCategories() {
  const categories = [...new Set(allProducts.map((p) => p.category))].sort();
  categoryFilter.innerHTML = '<option value="">Все категории</option>';
  for (const cat of categories) {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    categoryFilter.appendChild(opt);
  }
  categoryCountEl.textContent = categories.length;
}

function updateStats() {
  totalCountEl.textContent = allProducts.length;
  filteredCountEl.textContent = allProducts.length;
  totalCountLabel.textContent = `${allProducts.length} ${pluralize(allProducts.length, "товар", "товара", "товаров")}`;

  if (allProducts.length > 0) {
    const maxDisc = Math.max(...allProducts.map((p) => p.discount));
    maxDiscountEl.textContent = `\u2212${maxDisc}%`;
    statsRow.style.display = "flex";
  } else {
    maxDiscountEl.textContent = "\u2014";
  }
}

function pluralize(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const lastDigit = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (lastDigit > 1 && lastDigit < 5) return few;
  if (lastDigit === 1) return one;
  return many;
}

async function loadProducts() {
  try {
    const resp = await fetch("./data/products.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.json();
    allProducts = Array.isArray(raw) ? raw : (raw.products || []);

    if (allProducts.length === 0) {
      loadingEl.style.display = "none";
      emptyStateEl.style.display = "flex";
      updateTimeEl.textContent = "Ожидание данных";
      return;
    }

    const lastUpdate = allProducts[0].scrapedAt;
    updateTimeEl.textContent = lastUpdate
      ? `Обновлено ${formatDate(lastUpdate)}`
      : "";

    updateStats();
    populateCategories();
    renderProducts();
  } catch (err) {
    emptyStateEl.style.display = "flex";
    emptyStateEl.querySelector("h3").textContent = "Ошибка загрузки";
    emptyStateEl.querySelector("p").textContent = "Не удалось загрузить данные. Попробуйте обновить страницу.";
  } finally {
    loadingEl.style.display = "none";
  }
}

// Event listeners
searchInput.addEventListener("input", renderProducts);
categoryFilter.addEventListener("change", renderProducts);
sortSelect.addEventListener("change", renderProducts);
minDiscountInput.addEventListener("input", () => {
  discountValueLabel.textContent = minDiscountInput.value;
  renderProducts();
});

// Initial load
loadProducts();
