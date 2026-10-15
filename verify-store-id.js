// Verifica, ejecutando la página real en jsdom (igual que un navegador:
// espera el evento load y usa las funciones del propio menú), que TODAS las
// llaves de localStorage quedan dentro del prefijo STORE_ID y que el menú ya
// no lee las llaves genéricas compartidas entre tiendas.
//
//   NODE_PATH=/ruta/node_modules node verify-store-id.js index.html
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const htmlPath = path.resolve(process.argv[2] || 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const STORE_ID = 'roles_de_familia_nsm_9f4c';
const P = (name) => `${STORE_ID}:${name}`;
const GENERIC = ['cart', 'theme', 'orderHistory', 'clientProfileData', 'lastDeliveryProfile'];

const results = [];
function check(name, cond, extra = '') {
    results.push({ name, ok: !!cond, extra });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
}

// Carga la página y espera a que el DOM esté listo, como un navegador.
function load(seed) {
    return new Promise((resolve, reject) => {
        const virtualConsole = new VirtualConsole();
        const errors = [];
        virtualConsole.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
        const timer = setTimeout(() => reject(new Error('la página no emitió "load" en 10s')), 10000);
        const dom = new JSDOM(html, {
            url: 'https://menus.example.com/roles-de-familia/',
            runScripts: 'dangerously',
            virtualConsole,
            beforeParse(window) {
                Object.entries(seed || {}).forEach(([k, v]) => window.localStorage.setItem(k, v));
            }
        });
        dom.window.addEventListener('load', () => {
            clearTimeout(timer);
            resolve({ dom, errors });
        });
    });
}

const tick = () => new Promise((r) => setTimeout(r, 20));

async function withPage(seed, fn) {
    const { dom, errors } = await load(seed);
    try {
        const real = errors.filter((m) => !/Not implemented/i.test(m));
        check('sin errores de script no controlados', real.length === 0, real.join(' | '));
        await fn(dom.window, dom);
    } finally {
        dom.window.close();
    }
}

(async function main() {
    // ------------------------------------------------------------ 1. Carga
    await withPage({}, async (w) => {
        check('la página termina de cargar', w.document.readyState === 'complete', w.document.readyState);
        check('window.STORE_ID definido en el <head>', w.STORE_ID === STORE_ID, String(w.STORE_ID));
        check('STORE_KEY arma el prefijo', w.STORE_KEY('cart') === P('cart'), String(w.STORE_KEY('cart')));
        check('el script principal ya está activo (handler de carga ejecutado)',
            w.document.getElementById('appHeader') !== null &&
            typeof w.adjustSimpleProductQuantity === 'function' && typeof w.saveCart === 'function');
        check('el menú renderiza los 6 productos', w.document.querySelectorAll('.product-card').length === 6,
            String(w.document.querySelectorAll('.product-card').length));
        check('la pantalla inicial es el menú', w.document.getElementById('screen-home').classList.contains('active'));
        check('nada escrito todavía en llaves genéricas',
            GENERIC.every((k) => w.localStorage.getItem(k) === null));
    });

    // --------------------------------------------- 2. Carrito, tema, cliente
    await withPage({}, async (w) => {
        w.adjustSimpleProductQuantity(1, 1);          // añade 1 × Rol clásico
        w.adjustSimpleProductQuantity(1, 1);          // +1 → cantidad 2

        const cartRaw = w.localStorage.getItem(P('cart'));
        const cart = cartRaw ? JSON.parse(cartRaw) : null;
        check('el carrito se guarda en la llave con prefijo', Array.isArray(cart) && cart.length === 1, cartRaw);
        check('la cantidad quedó persistida', cart && cart[0].quantity === 2, cart && String(cart[0].quantity));
        check('NO se escribió la llave genérica "cart"', w.localStorage.getItem('cart') === null);

        w.toggleTheme();
        check('el tema se guarda en la llave con prefijo', w.localStorage.getItem(P('theme')) === 'dark',
            String(w.localStorage.getItem(P('theme'))));
        check('NO se escribió la llave genérica "theme"', w.localStorage.getItem('theme') === null);

        w.document.getElementById('customerName').value = 'Ana López';
        w.document.getElementById('customerPhone').value = '5512345678';
        w.document.getElementById('customerNotes').value = 'Sin nueces';
        w.saveClientDataSilently();
        const client = JSON.parse(w.localStorage.getItem(P('clientProfileData')) || '{}');
        check('los datos del cliente usan la llave con prefijo',
            client.name === 'Ana López' && client.phone === '5512345678', JSON.stringify(client));
        check('NO se escribió la llave genérica "clientProfileData"',
            w.localStorage.getItem('clientProfileData') === null);

        w.saveOrderToHistory({ id: 'PED-1', timestamp: Date.now(), items: [], total: 65, subtotal: 65 });
        const hist = JSON.parse(w.localStorage.getItem(P('orderHistory')) || '[]');
        check('el historial usa la llave con prefijo', hist.length === 1 && hist[0].id === 'PED-1', JSON.stringify(hist));
        check('NO se escribió la llave genérica "orderHistory"', w.localStorage.getItem('orderHistory') === null);

        const usedKeys = Object.keys(w.localStorage).sort();
        check('solo se usan llaves con el prefijo de esta tienda',
            usedKeys.length > 0 && usedKeys.every((k) => k.startsWith(STORE_ID + ':')), usedKeys.join(', '));
    });

    // ------------------------------ 3. Dirección de entrega (flujo real: se relee y se reguarda)
    await withPage({
        [P('lastDeliveryProfile')]: JSON.stringify({
            address: 'Cocoteros 229, Nueva Santa María, CDMX',
            coords: { lat: 19.4677, lng: -99.1657 },
            details: 'Portón negro, junto a la farmacia',
            deliveryFor: 'me',
            zone: 'Zona Cercana'
        })
    }, async (w) => {
        await tick();                       // la página relee el perfil guardado al cargar
        check('la dirección guardada se muestra en el formulario',
            w.document.getElementById('deliveryAddressText').textContent.includes('Cocoteros 229'),
            w.document.getElementById('deliveryAddressText').textContent);
        w.saveDeliveryDataSilently();       // y se vuelve a guardar desde el flujo normal
        const deliv = JSON.parse(w.localStorage.getItem(P('lastDeliveryProfile')) || '{}');
        check('la última dirección usa la llave con prefijo',
            String(deliv.address).includes('Cocoteros 229'), JSON.stringify(deliv));
        check('NO se escribió la llave genérica "lastDeliveryProfile"',
            w.localStorage.getItem('lastDeliveryProfile') === null);
    });

    // ----------------------------------- 4. Bootstrap del tema antes del primer pintado
    await withPage({ theme: 'dark', [P('theme')]: 'light' }, async (w) => {
        check('ignora el "theme" genérico (compartido) y usa el suyo',
            w.document.documentElement.getAttribute('data-theme') === 'light',
            w.document.documentElement.getAttribute('data-theme'));
    });

    await withPage({ [P('theme')]: 'dark' }, async (w) => {
        check('el tema propio se aplica al instante (sin parpadeo)',
            w.document.documentElement.getAttribute('data-theme') === 'dark',
            w.document.documentElement.getAttribute('data-theme'));
    });

    await withPage({ theme: 'dark' }, async (w) => {
        check('ya no hereda el tema de otras tiendas del dominio',
            w.document.documentElement.getAttribute('data-theme') === 'light',
            w.document.documentElement.getAttribute('data-theme'));
    });

    // ------------------------------------------------- 5. Aislamiento entre tiendas
    await withPage({
        [P('cart')]: JSON.stringify([{ id: 1, name: 'Rol de canela glaseado clásico', price: 65, quantity: 1, uniqueId: '1-none-' }])
    }, async (w) => {
        w.localStorage.setItem('otra_tienda_abc123:cart', JSON.stringify([{ id: 99, name: 'Pizza', price: 100, quantity: 3 }]));
        w.adjustSimpleProductQuantity(2, 1);   // añade un producto distinto en ESTA tienda

        const mine = JSON.parse(w.localStorage.getItem(P('cart')));
        const other = JSON.parse(w.localStorage.getItem('otra_tienda_abc123:cart'));
        check('el carrito propio conserva lo suyo y suma lo nuevo', mine.length === 2,
            JSON.stringify(mine.map((i) => i.name)));
        check('el carrito de la otra tienda queda intacto',
            other.length === 1 && other[0].name === 'Pizza' && other[0].quantity === 3, JSON.stringify(other));
        check('el carrito de la otra tienda nunca entra al menú',
            w.document.getElementById('bottomNavBadge').textContent === '2',
            w.document.getElementById('bottomNavBadge').textContent);
    });

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} comprobaciones OK`);
    process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
    console.error('Error del arnés de pruebas:', e);
    process.exit(2);
});
