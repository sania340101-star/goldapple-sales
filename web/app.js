/** @type {Array<{id:string, name:string, brand:string, price:number, oldPrice:number, discount:number, imageUrl:string, productUrl:string, category:string, scrapedAt:string}>} */
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
const productCountEl = document.getElementById("product-count");
const refreshBtn = document.getElementById("refresh-btn");

function formatPrice(value) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "BYN",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(isoString) {
  if (!isoString) return "никогда";
  const d = new Date(isoString);
  return d.toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function createProductCard(product) {
  const card = document.createElement("a");
  card.className = "product-card";
  card.href = product.productUrl;
  card.target = "_blank";
  card.rel = "noopener noreferrer";

  const imgSrc = product.imageUrl || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'%3E%3Crect fill='%23f0f0f0' width='200' height='200'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='.3em' fill='%23ccc' font-size='14'%3EНет фото%3C/text%3E%3C/svg%3E";

  card.innerHTML = `
    <div class="product-image">
      <img src="${imgSrc}" alt="${product.name}" loading="lazy" onerror="this.src='data:image/svg+xml,%253Csvg xmlns=%2527http://www.w3.org/2000/svg%2527 viewBox=%25270 0 200 200%2527%253E%253Crect fill=%2527%2523f0f0f0%2527 width=%2527200%2527 height=%2527200%2527/%253E%253Ctext x=%252750%2525%2527 y=%252750%2525%2527 text-anchor=%2527middle%2527 dy=%2527.3em%2527 fill=%2527%2523ccc%2527 font-size=%252714%2527%253E%25D0%259D%25D0%25B5%25D1%2582 %25D1%2584%25D0%25BE%25D1%2582%25D0%25BE%253C/text%253E%253C/svg%253E'" />
      <span class="discount-badge">-${product.discount}%</span>
    </div>
    <div class="product-info">
      <span class="product-brand">${escapeHtml(product.brand)}</span>
      <span class="product-name">${escapeHtml(product.name)}</span>
      <div class="product-prices">
        <span class="price-current">${formatPrice(product.price)}</span>
        <span class="price-old">${formatPrice(product.oldPrice)}</span>
      </div>
      <span class="product-category">${escapeHtml(product.category)}</span>
    </div>
  `;

  return card;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
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

  if (filtered.length === 0) {
    emptyStateEl.style.display = "block";
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

  productCountEl.textContent = `${filtered.length} из ${allProducts.length} товаров`;
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
}

async function loadProducts() {
  try {
    const resp = await fetch("./data/products.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const products = await resp.json();
    allProducts = Array.isArray(products) ? products : (products.products || []);
    const lastUpdate = allProducts.length > 0 ? allProducts[0].scrapedAt : null;
    updateTimeEl.textContent = lastUpdate
      ? `Обновлено: ${formatDate(lastUpdate)}`
      : "Данные ещё не загружены";
    populateCategories();
    renderProducts();
  } catch (err) {
    emptyStateEl.style.display = "block";
    emptyStateEl.querySelector("p").textContent =
      "Ошибка загрузки данных. Попробуйте обновить страницу.";
  } finally {
    loadingEl.style.display = "none";
  }
}

function triggerRefresh() {
  location.reload();
}

// Event listeners
searchInput.addEventListener("input", renderProducts);
categoryFilter.addEventListener("change", renderProducts);
sortSelect.addEventListener("change", renderProducts);
minDiscountInput.addEventListener("input", () => {
  discountValueLabel.textContent = minDiscountInput.value;
  renderProducts();
});
refreshBtn.addEventListener("click", triggerRefresh);

// Initial load
loadProducts();
