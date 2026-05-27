const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const http = require('http');
const pino = require('pino');
const fs = require('fs');
const mysql = require('mysql2/promise');
const axios = require('axios');

// CAPTURA GLOBAL DE ERRORES EVITA QUE EL BOT MUERA
process.on('unhandledRejection', (err) => {
    const msg = err?.message || err;
    console.log("[UNHANDLED] Error no capturado:", msg);
    if (msg === "Connection Closed" && socketBot) {
        setTimeout(() => startBot(), 3000);
    }
});
process.on('uncaughtException', (err) => {
    console.log("[UNCAUGHT] Error crítico:", err?.message || err);
});

// MODULOS EXTERNOS
const cobranza = require('./cobranza');
const marketingModulo = require('./marketing');
const notificador = require('./notificador_local');

// CONFIGURACION
const PORT = process.env.PORT || 10000;

// LISTA DE ADMINISTRADORES
const ADMIN_IDS = ["228621243408492", "97899534934200", "584142531553", "250370957778958", "244362214650069", "60305753296939", "1924162162820", "39058600415402", "58381658247238"];   

const pool = mysql.createPool({
    host: 'one4cars.com',
    user: 'juant200_one4car',
    password: 'Notieneclave1*',
    database: 'juant200_venezon',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const PDF_URL_CATALOGO = "https://www.one4cars.com/sevencorpweb/uploads/precios/Catalogo%20-%20ONE4CARS_compressed.pdf";

const MENU_TEXT = `📋 *MENÚ PRINCIPAL ONE4CARS*

1️⃣ *Medios de pago:* https://www.one4cars.com/medios_de_pago.php/
2️⃣ *Estado de cuenta:* https://www.one4cars.com/estado_de_cuenta.php/
3️⃣ *Lista de precios:* https://www.one4cars.com/lista_de_precios.php/
4️⃣ *Tomar pedido:* https://www.one4cars.com/tomar_pedido.php/
5️⃣ *Mis clientes/Vendedores:* https://www.one4cars.com/mis_clientes.php/
6️⃣ *Afiliar cliente:* https://www.one4cars.com/afiliar_clientes.php/
7️⃣ *Consulta de productos:* https://www.one4cars.com/consulta_productos.php/
8️⃣ *Seguimiento Despacho:* https://www.one4cars.com/despacho.php/
9️⃣ *Asesor Humano:* Indique su duda y un operador revisará el caso pronto.

_Escriba el número de la opción o su consulta directamente._`;

const MENU_INTENTIONS = {
    '1': { keywords: ['medios de pago', 'pago movil', 'datos de pago', 'como pagar', 'datos bancarios', 'cuentas para pagar'], response: `1️⃣ *Medios de pago:* https://www.one4cars.com/medios_de_pago.php/` },
    '2': { keywords: ['estado de cuenta', 'cuanto debo', 'listado de facturas pendiente', 'mi saldo', 'facturas pendientes', 'mi deuda', 'listado de facturas', 'cuentas por cobrar'], response: `2️⃣ *Estado de cuenta:* https://www.one4cars.com/estado_de_cuenta.php/` },
    '3': { keywords: ['lista de precios', 'listado de precios', 'catalogo de precios', 'cuanto cuestan' , 'pasame la lista', 'ver precios'], response: `3️⃣ *Lista de precios:* https://www.one4cars.com/lista_de_precios.php/` },
    '4': { keywords: ['tomar pedido', 'hacer un pedido', 'quiero comprar', 'realizar pedido'], response: `4️⃣ *Tomar pedido:* https://www.one4cars.com/tomar_pedido.php/` },
    '5': { keywords: ['mis clientes', 'lista de vendedores', 'mis vendedores', 'ver mis clientes'], response: `5️⃣ *Mis clientes/Vendedores:* https://www.one4cars.com/mis_clientes.php/` },
    '6': { keywords: ['afiliar cliente', 'registrar cliente', 'dar de alta cliente', 'nuevo cliente'], response: `6️⃣ *Afiliar cliente:* https://www.one4cars.com/afiliar_clientes.php/` },
    '7': { keywords: ['consulta de productos', 'buscar en inventario', 'ver disponibilidad',  'saber de sus productos', 'buscar repuesto'], response: `7️⃣ *Consulta de productos:* https://www.one4cars.com/consulta_productos.php/` },
    '8': { keywords: ['seguimiento despacho', 'donde esta mi pedido', 'estatus del envio', 'rastrear pedido'], response: `8️⃣ *Seguimiento Despacho:* https://www.one4cars.com/despacho.php/` },
    '9': { keywords: ['asesor humano', 'hablar con un operador', 'soporte humano', 'quiero hablar con alguien', 'ayuda de un operador'], response: `9️⃣ *Asesor Humano:* Indique su duda y un operador revisará el caso pronto. 👩‍💻` }
};

let qrCodeData = "Iniciando...";
let socketBot = null;
let dolarInfo = { bcv: 'Cargando...', paralelo: 'Cargando...' };
let notificadorInterval = null;

// ===== FUNCIONES DE APOYO =====

function normalizar(texto) {
    return texto
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") 
        .toLowerCase()
        .trim();
}

function limpiarRIF(texto) {
    return texto.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function soloNumerosRIF(texto) {
    return texto.replace(/\D/g, '');
}

async function safeSendMessage(jid, content) {
    try {
        if (!socketBot) throw new Error("Socket no inicializado");
        await socketBot.sendMessage(jid, content);
    } catch (e) {
        console.log(`[MSG] ❌ Error enviando mensaje:`, e.message);
    }
}

function isBotReady() {
    return socketBot && socketBot.user && socketBot.user.id;
}

function formatWhatsApp(jid) {
    if (!jid) return null;
    if (jid.toString().includes('@')) return jid;
    let clean = jid.toString().replace(/\D/g, ''); 
    if (clean.startsWith('580')) { clean = '58' + clean.substring(3); }
    if (clean.length > 15) return `${clean}@lid`;
    if (clean.startsWith('0')) clean = clean.substring(1);
    if (!clean.startsWith('58')) clean = '58' + clean;
    return `${clean}@s.whatsapp.net`;
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const randomDelay = async () => {
    const ms = Math.floor(Math.random() * (25000 - 15000 + 1)) + 15000; 
    await sleep(ms);
};

async function guardarMensaje(tel, rol, contenido) {
    try {
        await pool.execute("INSERT INTO historial_chat (telefono, rol, contenido) VALUES (?, ?, ?)", [tel, rol, contenido]);
    } catch (e) { console.log("Error guardando historial"); }
}

async function setModo(tel, modo) {
    await pool.execute("INSERT INTO control_chat (telefono, modo) VALUES (?, ?) ON DUPLICATE KEY UPDATE modo = VALUES(modo)", [tel, modo]);
}

async function buscarVendedor(jid, pushName) {
    const telLimpio = jid.split('@')[0]; 
    const [r] = await pool.execute(
        "SELECT * FROM tab_vendedores WHERE celular_vendedor LIKE ? OR telefono_vendedor LIKE ? OR nombre LIKE ? LIMIT 1", 
        [`%${telLimpio}%`, `%${telLimpio}%`, `%${pushName}%`]
    );
    return r[0] || null;
}

function detectarIntencionMenu(texto) {
    if (!texto) return null;
    if (/^\d$/.test(texto)) {
        const num = texto.charAt(0);
        if (MENU_INTENTIONS[num]) return MENU_INTENTIONS[num].response;
    }
    for (const key in MENU_INTENTIONS) {
        const intention = MENU_INTENTIONS[key];
        if (intention.keywords.some(phrase => texto.includes(phrase))) {
            return intention.response;
        }
    }
    return null;
}

// ===== BASE DE DATOS =====
async function initDB() {
    try {
        await pool.execute(`CREATE TABLE IF NOT EXISTS control_chat (
            telefono VARCHAR(100) PRIMARY KEY, 
            usuario VARCHAR(50), 
            id_cliente_int INT,
            modo VARCHAR(20) DEFAULT 'bot', 
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
        
        await pool.execute(`CREATE TABLE IF NOT EXISTS historial_chat (
            id INT AUTO_INCREMENT PRIMARY KEY, 
            telefono VARCHAR(100), 
            rol ENUM('user', 'model'), 
            contenido TEXT, 
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);

        await pool.execute(`CREATE TABLE IF NOT EXISTS recordatorios_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            id_factura INT NOT NULL,
            nivel INT NOT NULL,
            fecha_envio TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_recordatorio (id_factura, nivel)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);

        await pool.execute(`CREATE TABLE IF NOT EXISTS envio_vendedor_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            fecha_envio DATE NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
        
        console.log("✅ Base de Datos vinculada.");
    } catch (e) { console.log("❌ Error DB Init:", e.message); }
}

async function getSesion(jid) {
    const [r] = await pool.execute("SELECT * FROM control_chat WHERE telefono=?", [jid]);
    return r[0] || null;
}

async function guardarUsuario(jid, usuario, id_int) {
    await pool.execute(`
        INSERT INTO control_chat (telefono, usuario, id_cliente_int, modo) 
        VALUES (?, ?, ?, 'bot') 
        ON DUPLICATE KEY UPDATE usuario=VALUES(usuario), id_cliente_int=VALUES(id_cliente_int), modo='bot'
    `, [jid, usuario, id_int]);
}

async function buscarCliente(rifLimpio) {
    const soloNum = soloNumerosRIF(rifLimpio);
    const [r] = await pool.execute(
        "SELECT id_cliente, nombres, celular, cedula, direccion, zona FROM tab_clientes WHERE clave = ? OR clave = ? OR clave LIKE ? LIMIT 1", 
        [rifLimpio, soloNum, `%${rifLimpio}%`]
    );
    return r[0] || null;
}

// ============================================================
// LÓGICA DE BÚSQUEDA DE PRODUCTOS (SISTEMA DE RELEVANCIA)
// ============================================================
async function buscarProductoPorTexto(texto) {
    const txtNormal = normalizar(texto);
    
    const stopWords = [
        'tienes', 'tendra', 'tendras', 'tendria', 'tienen', 'la', 'del', 'quiere', 'saber', 'cuanto', 'mide', 'venden', 'donde',
        'precio', 'el', 'una', 'un', 'hay', 'si', 'es', 'de', 'con', 'para', 'por', 'en', 'al', 'lo', 'los', 'las',
        'busco', 'buscando', 'hola', 'buenos', 'buenas', 'dias', 'tardes', 'noches', 'como', 'estas',
        'esta', 'familia', 'espero', 'encuentres', 'bien', 'queria', 'quería',
        'preguntarte', 'gracias', 'favor', 'ayuda', 'puedes', 'podrias', 'podrías',
        'quisiera', 'necesito', 'saludos', 'cordial', 'muchas', 'todo', 'bienvenidos',
        'bendiciones', 'exito', 'exitos', 'dia', 'tarde', 'noche', 'pregunta', 'consulta',
        'atento', 'atenta', 'saludo', 'estimados', 'estimado', 'buen', 'buena', 'bueno',
        'se', 'me', 'le', 'te', 'lo', 'los', 'las', 'les', 'su', 'sus', 'mi', 'mis',
        'tu', 'tus', 'nos', 'os', 'que', 'cual', 'cuales', 'quien', 'quienes',
        'cuando', 'porque', 'pues', 'pero', 'mas', 'muy', 'asi', 'aun', 'entre', 'sin',
        'sobre', 'tras', 'durante', 'mediante', 'excepto', 'segun', 'puede', 'puedo',
        'pueden', 'podemos', 'podria', 'hacer', 'hace', 'hacen', 'ser', 'estar', 'tener',
        'tengo', 'tenemos', 'tiene', 'decir', 'dice', 'dicen', 'digo', 'ver', 'veo',
        'ven', 'vez', 'veces', 'quiero', 'quiere', 'quieren', 'queremos', 'gustaria',
        'gusta', 'gustan', 'gusto', 'necesita', 'necesitan', 'necesitamos', 'pueda','UNID.','unid.','unidades','unidad','UNIDADES','unidades',
        'puedas', 'pudiera', 'pudieras', 'listo', 'claro', 'ok', 'okey', 'vale', 'va',
        'vamos', 'vaya', 'algun', 'alguna', 'algunos', 'algunas', 'ningun', 'ninguna',
        'tipo', 'tipos', 'preguntar', 'disculpa', 'disculpe', 'permiso', 'ayudar',
        'apoyo', 'consulta', 'consultar', 'info', 'informacion', 'decirme', 'dime',
        'avísame', 'avisa', 'saber', 'sabes', 'saben', 'sabemos',
        'pana', 'panas', 'brother', 'bro', 'amigo', 'amigos', 'compa', 'compadre',
        'ando', 'andas', 'andan', 'andaba', 'andabas', 'andabamos', 'andaban',
        'estoy', 'estas', 'esta', 'estaba', 'estabas', 'estabamos', 'estaban',
        'vengo', 'vienes', 'viene', 'vienen', 'venia', 'venias', 'veniamos', 'venian',
        'voy', 'vas', 'va', 'vamos', 'van', 'iba', 'ibas', 'ibamos', 'iban',
        'llegando', 'pais', 'país', 'atento'
    ];

    const esMedida = txtNormal.includes('x');
    let palabrasBase = [];

    if (esMedida) {
        palabrasBase = [txtNormal];
    } else {
        palabrasBase = txtNormal.split(' ')
            .filter(p => p.length > 2 && !stopWords.includes(p));
    }

    if (palabrasBase.length === 0) return null;

    const stockCondition = "(cantidad_existencia + cantidad_existencia_almacen > 0)";
    
    try {
        // Construimos una query que sume puntos por cada palabra encontrada
        // Esto hace que el producto que más coincida salga primero, aunque no tenga todas las palabras.
        let relevanceSql = "";
        let whereClause = "";
        let params = [];

        palabrasBase.forEach((pal, index) => {
            relevanceSql += `(CASE WHEN producto LIKE ? OR descripcion LIKE ? OR equivalencia LIKE ? THEN 1 ELSE 0 END) + `;
            whereClause += `(producto LIKE ? OR descripcion LIKE ? OR equivalencia LIKE ?)`;
            if (index < palabrasBase.length - 1) whereClause += " OR ";
            params.push(`%${pal}%`, `%${pal}%`, `%${pal}%`);
        });
        
        // Duplicamos los parámetros para el ORDER BY (que usa la misma lógica)
        const finalParams = [...params, ...params];
        relevanceSql = relevanceSql.slice(0, -3);

        const sql = `
            SELECT producto, descripcion, tipo, precio_final 
            FROM tab_productos 
            WHERE ${stockCondition} AND ${whereClause} 
            ORDER BY (${relevanceSql}) DESC 
            LIMIT 8`;
            
        const [rows] = await pool.execute(sql, finalParams);
        if (rows.length > 0) return rows;
    } catch (e) {
        console.log("Error en búsqueda de productos:", e);
    }

    return null;
}

async function obtenerDetalleFacturas(id_cliente, id_vendedor = null) {
    let query = `
        SELECT f.id_factura, f.nro_factura, f.total, f.abono_factura, f.fecha_reg, f.porcentaje, f.descuento, f.total_desc,
                c.nombres, c.direccion, c.cedula, c.celular, c.telefono, c.id_cliente, c.zona, c.vendedor as nombre_vendedor
         FROM tab_facturas f
         JOIN tab_clientes c ON f.id_cliente = c.id_cliente
         WHERE f.id_cliente = ? AND f.pagada = 'NO' AND f.anulado = 'no'`;
    let params = [id_cliente];
    if (id_vendedor) { query += ` AND f.id_vendedor = ?`; params.push(id_vendedor); }
    const [facturas] = await pool.execute(query, params);
    return facturas;
}

async function actualizarDolar() {
    try {
        const resOficial = await axios.get('https://ve.dolarapi.com/v1/dolares/oficial', { timeout: 7000 });
        if (resOficial.data) dolarInfo.bcv = parseFloat(resOficial.data.promedio).toFixed(2);
        const resParalelo = await axios.get('https://ve.dolarapi.com/v1/dolares/paralelo', { timeout: 7000 });
        if (resParalelo.data) dolarInfo.paralelo = parseFloat(resParalelo.data.promedio).toFixed(2);
    } catch (e) { console.log("Error Dolar API"); }
}

// ===== NOTIFICADOR DE FACTURAS NUEVAS =====
let notificadorEjecutando = false;

async function checkNuevasFacturas() {
    if (!isBotReady() || notificadorEjecutando) return;
    notificadorEjecutando = true;
    try {
        const facturas = await notificador.obtenerFacturasNoNotificadas();
        for (const f of facturas) {
            const jid = formatWhatsApp(f.celular);
            if (!jid) continue;
            const fecha = new Date(f.fecha_reg).toISOString().split('T')[0];
            const msg = `🧾 *NUEVA FACTURA REGISTRADA*\n\nHola *${f.nombres}*, se ha registrado una nueva factura en nuestro sistema:\n\n🔹 *N°:* ${f.nro_factura}\n🔹 *Monto:* $${parseFloat(f.total).toFixed(2)}\n🔹 *Fecha:* ${fecha}\n\nPuede consultar su estado de cuenta en:\nhttps://www.one4cars.com/estado_de_cuenta.php/`;
            await safeSendMessage(jid, { text: msg });

            if (f.celular_vendedor) {
                const jidV = formatWhatsApp(f.celular_vendedor);
                if (jidV) {
                    const msgV = `📢 *NUEVA FACTURA DE SU CLIENTE*\n\nVendedor: *${f.vendedor_nombre || 'N/A'}*\nCliente: *${f.nombres}*\n\n🔹 *N° Factura:* ${f.nro_factura}\n🔹 *Monto:* $${parseFloat(f.total).toFixed(2)}\n🔹 *Fecha:* ${fecha}`;
                    await safeSendMessage(jidV, { text: msgV });
                }
            }

            await pool.execute("UPDATE tab_facturas SET whatsapp_notificado = 'SI' WHERE id_factura = ?", [f.id_factura]);
            await sleep(1000);
        }
    } catch (e) {
        console.log("[NOTIFICADOR] Error:", e.message);
    } finally {
        notificadorEjecutando = false;
    }
}

// ===== RECORDATORIOS DE FACTURAS VENCIDAS =====
let recordatorioEjecutando = false;

function obtenerNivelRecordatorio(dias) {
    if (dias >= 60) return 60;
    if (dias >= 50) return 50;
    if (dias >= 40) return 40;
    if (dias >= 30) return 30;
    return null;
}

function obtenerTonoMensaje(nivel, f, monto, fecha) {
    if (nivel >= 60) {
        return `🧾 *AVISO DE PAGO PENDIENTE*\n\nHola *${f.nombres}*, la factura *N° ${f.nro_factura}* emitida el *${fecha}* ya superó los 60 días de vencida con un saldo de *$${monto.toFixed(2)}*.\n\nEl retraso en el pago afecta la rotación de nuestros productos. Le agradecemos realizar el pago a la mayor brevedad posible. 🚗`;
    }
    return `🧾 *RECORDATORIO DE PAGO*\n\nHola *${f.nombres}*, le recordamos amablemente que la factura *N° ${f.nro_factura}* con fecha *${fecha}* presenta un saldo pendiente de *$${monto.toFixed(2)}*.\n\nLe agradecemos gestionar el pago para mantener su cuenta al día. 🚗`;
}

async function checkFacturasVencidas() {
    if (!isBotReady() || recordatorioEjecutando) return;
    recordatorioEjecutando = true;
    try {
        const facturas = await notificador.obtenerFacturasVencidas();
        const enviados = await notificador.obtenerRecordatoriosEnviados();
        let cont = 0;

        for (const f of facturas) {
            const dias = f.dias_vencida;
            const nivel = obtenerNivelRecordatorio(dias);
            if (!nivel) continue;

            const monto = (parseFloat(f.total) - parseFloat(f.abono_factura || 0)) / (parseFloat(f.porcentaje) || 1);
            if (monto <= 0) continue;

            const fecha = new Date(f.fecha_reg).toISOString().split('T')[0];
            const yaEnviado = enviados[f.id_factura] && enviados[f.id_factura].includes(nivel);
            if (!yaEnviado) {
                const jid = formatWhatsApp(f.celular);
                if (jid) {
                    const msg = obtenerTonoMensaje(nivel, f, monto, fecha);
                    await safeSendMessage(jid, { text: msg });
                }
                await notificador.marcarRecordatorio(f.id_factura, nivel);
                cont++;
                await sleep(1000);
            }
        }
    } catch (e) {
        console.log("[RECORDATORIO] Error:", e.message);
    } finally {
        recordatorioEjecutando = false;
    }
}

// ===== RECORDATORIO A VENDEDORES =====
let vendedorEjecutando = false;

async function checkVendedoresRecordatorio() {
    if (!isBotReady() || vendedorEjecutando) return;
    vendedorEjecutando = true;
    try {
        const hoy = new Date().getDay();
        if (hoy === 0 || hoy === 6) return;

        const ultimo = await notificador.obtenerUltimoEnvioVendedor();
        if (ultimo) {
            const diff = Math.floor((new Date() - new Date(ultimo)) / 86400000);
            if (diff < 3) return;
        }

        const facturas = await notificador.obtenerFacturasVencidasAll();
        const vendedoresMap = {};

        for (const f of facturas) {
            const dias = f.dias_vencida;
            if (dias < 30) continue;

            let monto = (parseFloat(f.total) - parseFloat(f.abono_factura || 0)) / (parseFloat(f.porcentaje) || 1);
            if (monto <= 0 || !f.celular_vendedor) continue;

            if (f.vendedor_nombre && f.vendedor_nombre.toUpperCase() === 'MANUEL FERRAZ') {
                monto = monto / 0.80;
            }

            const key = f.celular_vendedor.toString().replace(/\D/g, '');
            if (!vendedoresMap[key]) {
                vendedoresMap[key] = {
                    nombre: f.vendedor_nombre || 'Vendedor',
                    jid: formatWhatsApp(f.celular_vendedor),
                    facturas: []
                };
            }
            vendedoresMap[key].facturas.push(`🔹 *N° ${f.nro_factura}* - ${f.nombres} - $${monto.toFixed(2)} (${dias} días)`);
        }

        for (const key of Object.keys(vendedoresMap)) {
            const v = vendedoresMap[key];
            if (!v.jid || v.facturas.length === 0) continue;
            const msg = `📢 *RESUMEN DE CLIENTES VENCIDOS*\n\nVendedor: *${v.nombre}*\n\n${v.facturas.join('\n')}\n\nLe recordamos la importancia de gestionar estos cobros.`;
            await safeSendMessage(v.jid, { text: msg });
            await sleep(1000);
        }

        await notificador.marcarEnvioVendedor();
    } catch (e) {
        console.log("[VENDEDORES] Error:", e.message);
    } finally {
        vendedorEjecutando = false;
    }
}

// ===== BOT WHATSAPP =====
async function startBot() {
    if (socketBot) {
        try {
            socketBot.removeAllListeners();
            socketBot.end(undefined);
        } catch (e) {}
        socketBot = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["ONE4CARS MASTER", "Chrome", "1.0.0"]
    });

    socketBot = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect, qr } = u;
        if (qr) qrcode.toDataURL(qr, { scale: 10 }, (_, url) => qrCodeData = url);
        if (connection === 'open') { 
            qrCodeData = "ONLINE ✅"; 
            console.log("🚀 BOT MASTER ONLINE");
            if (!notificadorInterval) {
                notificadorInterval = setInterval(checkNuevasFacturas, 45000);
                setInterval(checkFacturasVencidas, 86400000);
                setInterval(checkVendedoresRecordatorio, 86400000);
                setInterval(() => {
                    if (!isBotReady() && socketBot) startBot();
                }, 300000);
            }
        }
        if (connection === 'close') {
            const r = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (r) setTimeout(() => startBot(), 5000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            if (type !== 'notify') return;
            const msg = messages[0];
            if (!msg.message) return;

            const from = msg.key.remoteJid;
            if (from === 'status@broadcast' || from.includes('@g.us')) return;

            const isAdmin = ADMIN_IDS.some(id => from.includes(id));
            const vendedor = await buscarVendedor(from, msg.pushName || "Vendedor");

            if (msg.key.fromMe) {
                const textMe = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();
                if (textMe === '!bot') {
                    await setModo(from, 'bot');
                    await safeSendMessage(from, { text: "🤖 Bot reactivado para este chat." });
                } else {
                    await setModo(from, 'humano');
                }
                return;
            }

            const pushName = msg.pushName || "Usuario";
            const rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
            if (!rawText) return;

            const text = normalizar(rawText);
            await guardarMensaje(from, 'user', rawText);
            
            const sesion = await getSesion(from);
            if (sesion && sesion.modo === 'humano' && !isAdmin) return;

            // --- 1. PRIORIDAD: BÚSQUEDA DE PRODUCTOS (ABIERTO A TODOS) ---
            if (!['hola', 'buen dia', 'buenos dias', 'menu'].includes(text)) {
                try {
                    const prods = await buscarProductoPorTexto(rawText);
                    if (prods) {
                        const saludos = [
                            "Saludos estimado , gracias por tu consulta puedo recomendarte estos artículos: 👇",
                            "¡Hola! He buscado en nuestro inventario y creo que estos artículos es lo que buscas: 👇",
                            "Con gusto le ayudo. Segun lo que me dices, aquí tienes la mejor opcion disponible: 👇",
                            "Hola, un placer saludarle. He encontrado estos productos que coinciden con su búsqueda: 👇"
                        ];
                        const saludoAzar = saludos[Math.floor(Math.random() * saludos.length)];
                        await safeSendMessage(from, { text: saludoAzar });
                        await sleep(1500);

                        for (const p of prods) {
                            if (!isBotReady()) break; 
                            const precioLimpio = parseFloat(p.precio_final || 0).toFixed(2);
                            const caption = `📦 *CÓDIGO: ${p.producto}*\n💰 *Precio Final: $${precioLimpio}*\n📝 ${p.descripcion}\n🔗 Ficha: https://one4cars.com/producto_general.php?cod=${p.producto}&tipo=${encodeURIComponent(p.tipo)}`;
                            const imgUrl = `https://one4cars.com/imagen/${p.producto}.jpg`;
                            try {
                                await socketBot.sendMessage(from, { image: { url: imgUrl }, caption: caption });
                            } catch (imgErr) {
                                await safeSendMessage(from, { text: caption });
                            }
                            await sleep(1500);
                        }
                        return; 
                    }
                } catch (e) { console.log("Error en flujo de productos:", e); }
            }

            // --- 2. BÚSQUEDA DE RIF (SÓLO ADMINS) ---
            const esRIFPuro = /^[vjgje]?\d+$/i.test(rawText.replace(/[^a-zA-Z0-9]/g, '')) && rawText.replace(/[^a-zA-Z0-9]/g, '').length >= 9;
            if (isAdmin && esRIFPuro) {
                const rifLimpio = limpiarRIF(rawText);
                const c = await buscarCliente(rifLimpio);
                if (c) {
                    await guardarUsuario(from, rifLimpio, c.id_cliente);
                    const facturas = await obtenerDetalleFacturas(c.id_cliente);
                    let totalP = 0; 
                    let list = `⭐ *CONSULTA DE ESTADO DE CUENTA (ADMIN)*\nCliente: ${c.nombres}\nRIF: ${rifLimpio}\n\n`;
                    if (facturas.length === 0) {
                        list += `✅ Sin facturas pendientes.`;
                    } else {
                        facturas.forEach(f => {
                            const monto = (f.total - f.abono_factura) / (f.porcentaje || 1);
                            totalP += monto;
                            list += `🔸 *#${f.nro_factura}* | $${monto.toFixed(2)}\n`;
                            list += `✍️ Firmada: https://www.one4cars.com/uploads/notas/${f.nro_factura}.jpg\n\n`;
                        });
                        list += `💰 *TOTAL A PAGAR: $${totalP.toFixed(2)}*`;
                    }
                    return await safeSendMessage(from, { text: list });
                } else {
                    if (rawText.length >= 9 && rawText.length <= 11) {
                        return await safeSendMessage(from, { text: "❌ No se encontró ningún cliente con ese RIF." });
                    }
                }
            }

            // --- 3. DETECCIÓN DEL MENÚ (ABIERTO A TODOS) ---
            const menuOption = detectarIntencionMenu(text);
            if (menuOption) {
                if (menuOption.includes('Estado de cuenta')) {
                    const targetID = sesion?.id_cliente_int;
                    if (!targetID) {
