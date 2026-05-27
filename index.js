const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const http = require('http');
const pino = require('pino');
const fs = require('fs');
const mysql = require('mysql2/promise');
const axios = require('axios');

// ==========================================
// CAPTURA GLOBAL DE ERRORES
// ==========================================
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

// ==========================================
// MODULOS EXTERNOS
// ==========================================
const cobranza = require('./cobranza');
const marketingModulo = require('./marketing');
const notificador = require('./notificador_local');

// ==========================================
// CONFIGURACION Y CONSTANTES
// ==========================================
const PORT = process.env.PORT || 10000;
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

let qrCodeData = "Iniciando...";
let socketBot = null;
let dolarInfo = { bcv: 'Cargando...', paralelo: 'Cargando...' };
let notificadorInterval = null;

// ==========================================
// FUNCIONES DE APOYO Y UTILIDADES
// ==========================================

function normalizar(texto) {
    if (!texto) return "";
    return texto
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") 
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?!]/g, "") 
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
        console.log(`[MSG] Error enviando a ${jid}:`, e.message);
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

// ==========================================
// PERSISTENCIA Y CONSULTAS DB
// ==========================================

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
        
        console.log("✅ Base de Datos Sincronizada.");
    } catch (e) { console.log("❌ Error DB Init:", e.message); }
}

async function getSesion(jid) {
    const [r] = await pool.execute("SELECT * FROM control_chat WHERE telefono=?", [jid]);
    return r[0] || null;
}

async function guardarMensaje(tel, rol, contenido) {
    try {
        await pool.execute("INSERT INTO historial_chat (telefono, rol, contenido) VALUES (?, ?, ?)", [tel, rol, contenido]);
    } catch (e) { console.log("Error guardando historial"); }
}

async function setModo(tel, modo) {
    await pool.execute("INSERT INTO control_chat (telefono, modo) VALUES (?, ?) ON DUPLICATE KEY UPDATE modo = VALUES(modo)", [tel, modo]);
}

async function guardarUsuario(jid, usuario, id_int) {
    await pool.execute(`
        INSERT INTO control_chat (telefono, usuario, id_cliente_int, modo) 
        VALUES (?, ?, ?, 'bot') 
        ON DUPLICATE KEY UPDATE usuario=VALUES(usuario), id_cliente_int=VALUES(id_cliente_int), modo='bot'
    `, [jid, usuario, id_int]);
}

async function buscarVendedor(jid, pushName) {
    const telLimpio = jid.split('@')[0]; 
    const [r] = await pool.execute(
        "SELECT * FROM tab_vendedores WHERE celular_vendedor LIKE ? OR telefono_vendedor LIKE ? OR nombre LIKE ? LIMIT 1", 
        [`%${telLimpio}%`, `%${telLimpio}%`, `%${pushName}%`]
    );
    return r[0] || null;
}

async function buscarCliente(rifLimpio) {
    const soloNum = soloNumerosRIF(rifLimpio);
    const [r] = await pool.execute(
        "SELECT id_cliente, nombres, celular, cedula, direccion, zona FROM tab_clientes WHERE clave = ? OR clave = ? OR clave LIKE ? LIMIT 1", 
        [rifLimpio, soloNum, `%${rifLimpio}%`]
    );
    return r[0] || null;
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

// ==========================================
// ALGORITMO DE BÚSQUEDA DE PRODUCTOS (INFALIBLE)
// ==========================================

async function buscarProductoPorTexto(texto) {
    const rawText = texto.trim().toUpperCase();
    
    // PRIMERO: Intento de búsqueda por código exacto (Prioridad Máxima)
    const [exactCode] = await pool.execute(
        "SELECT producto, descripcion, tipo, precio_final FROM tab_productos WHERE producto = ? AND (cantidad_existencia + cantidad_existencia_almacen > 0) LIMIT 1",
        [rawText]
    );
    if (exactCode.length > 0) return exactCode;

    const txtNormal = normalizar(texto);
    const stopWords = [
        'tienes', 'la', 'del', 'quiere', 'saber', 'cuanto', 'mide', 'venden', 'donde', 'precio', 'tienen', 'el', 'una', 'un', 'hay', 'si', 'es', 'de', 'con', 'para', 'busco', 'hola', 'buenos', 'buenas', 'dias', 'tardes', 'noches', 'como', 'estas', 'esta', 'familia', 'espero', 'encuentres', 'bien', 'queria', 'preguntarte', 'gracias', 'por', 'favor', 'ayuda', 'puedes', 'podrias', 'quisiera', 'necesito', 'saludos', 'cordial', 'muchas', 'todo', 'bienvenidos', 'bendiciones', 'exito', 'dia', 'tarde', 'noche', 'pregunta', 'consulta', 'atento', 'atenta', 'saludo', 'estimados', 'estimado', 'buen', 'buena', 'bueno', 'se', 'me', 'le', 'te', 'lo', 'los', 'las', 'les', 'su', 'sus', 'mi', 'mis', 'tu', 'tus', 'nos', 'os', 'que', 'cual', 'cuales', 'quien', 'quienes', 'cuando', 'porque', 'pues', 'pero', 'mas', 'muy', 'asi', 'aun', 'entre', 'sin', 'sobre', 'tras', 'durante', 'mediante', 'excepto', 'segun', 'puede', 'puedo', 'pueden', 'podemos', 'podria', 'hacer', 'hace', 'hacen', 'ser', 'estar', 'tener', 'tengo', 'tenemos', 'tiene', 'decir', 'dice', 'dicen', 'digo', 'ver', 'veo', 'ven', 'vez', 'veces', 'quiero', 'quiere', 'quieren', 'queremos', 'gustaria', 'gusta', 'gustan', 'gusto', 'necesita', 'necesitan', 'necesitamos', 'pueda', 'unid', 'unidades', 'unidad', 'puedas', 'pudiera', 'pudieras', 'listo', 'claro', 'ok', 'okey', 'vale', 'va', 'vamos', 'vaya', 'algun', 'alguna', 'algunos', 'algunas', 'ningun', 'ninguna', 'tipo', 'tipos', 'preguntar', 'disculpa', 'disculpe', 'permiso', 'ayudar', 'apoyo', 'info', 'informacion', 'decirme', 'dime', 'avisame', 'avisa', 'sabes', 'saben', 'sabemos', 'pana', 'panas', 'brother', 'bro', 'amigo', 'amigos', 'compa', 'compadre', 'ando', 'andas', 'andan', 'estoy', 'vengo', 'vienes', 'viene', 'voy', 'vas', 'va', 'llegando', 'pais', 'país'
    ];

    const palabrasBase = txtNormal.split(' ')
        .filter(p => p.length > 2 && !stopWords.includes(p));

    if (palabrasBase.length === 0) return null;

    const positionalWords = ['superior', 'sup', 'inferior', 'inf', 'interno', 'int', 'externo', 'ext', 'derecha', 'der', 'izquierda', 'izq'];
    const isOnlyPositional = palabrasBase.every(p => positionalWords.includes(p));
    if (isOnlyPositional) return null;

    const expandirFormas = (pal) => {
        const f = [pal];
        if (pal.endsWith('es') && pal.length > 4) f.push(pal.slice(0, -2));
        if (pal.endsWith('s') && pal.length > 3 && !pal.endsWith('es')) f.push(pal.slice(0, -1));
        if (!pal.endsWith('s')) {
            f.push(pal + 's');
            if (pal.endsWith('z')) f.push(pal.slice(0, -1) + 'ces');
        }
        return [...new Set(f)];
    };

    const stockCondition = "(cantidad_existencia + cantidad_existencia_almacen > 0)";
    
    // INTENTO 1: Búsqueda Estricta (Todas las palabras deben estar)
    let whereClause = "";
    let queryParams = [];
    palabrasBase.forEach((pal, index) => {
        const formas = expandirFormas(pal);
        const conditions = formas.map(() => "descripcion LIKE ?");
        whereClause += `(${conditions.join(" OR ")})`;
        if (index < palabrasBase.length - 1) whereClause += " AND ";
        formas.forEach(f => queryParams.push(`%${f}%`));
    });

    try {
        const sql = `SELECT producto, descripcion, tipo, precio_final FROM tab_productos WHERE ${stockCondition} AND ${whereClause} LIMIT 8`;
        const [rows] = await pool.execute(sql, queryParams);
        if (rows.length > 0) return rows;
    } catch (e) {}

    // INTENTO 2: Relevancia Dinámica (Filtrado por el máximo nivel de coincidencia)
    const expandedTerms = [...new Set(palabrasBase.flatMap(expandirFormas))];
    const orConditions = expandedTerms.map(() => "descripcion LIKE ?");
    const orParams = expandedTerms.map(p => `%${p}%`);

    const relevanceParts = palabrasBase.map(p => {
        const formas = expandirFormas(p);
        const cases = formas.map(f => `descripcion LIKE '%${f.replace(/[^a-z0-9]/g, '')}%'`);
        return `(CASE WHEN ${cases.join(' OR ')} THEN 1 ELSE 0 END)`;
    });
    const relevanceSQL = relevanceParts.join(' + ');

    try {
        // Obtenemos los productos con su score
        const sqlRelevancia = `
            SELECT producto, descripcion, tipo, precio_final, (${relevanceSQL}) as score
            FROM tab_productos 
            WHERE ${stockCondition} AND (${orConditions.join(" OR ")}) 
            ORDER BY score DESC 
            LIMIT 20`;
            
        const [rows] = await pool.execute(sqlRelevancia, orParams);
        if (rows.length > 0) {
            // FILTRADO CRÍTICO: Solo devolvemos los que tengan el score máximo encontrado
            const maxScore = rows[0].score;
            const mejoresResultados = rows.filter(r => r.score === maxScore);
            return mejoresResultados.slice(0, 8);
        }
    } catch (e) {}

    return null;
}

// ==========================================
// AUTOMATIZACIONES Y NOTIFICADORES
// ==========================================

async function checkNuevasFacturas() {
    if (!isBotReady()) return;
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
    } catch (e) { console.log("[NOTIFICADOR] Error:", e.message); }
}

async function checkFacturasVencidas() {
    if (!isBotReady()) return;
    try {
        const facturas = await notificador.obtenerFacturasVencidas();
        const enviados = await notificador.obtenerRecordatoriosEnviados();

        for (const f of facturas) {
            const dias = f.dias_vencida;
            let nivel = null;
            if (dias >= 60) nivel = 60;
            else if (dias >= 50) nivel = 50;
            else if (dias >= 40) nivel = 40;
            else if (dias >= 30) nivel = 30;

            if (!nivel) continue;

            const monto = (parseFloat(f.total) - parseFloat(f.abono_factura || 0)) / (parseFloat(f.porcentaje) || 1);
            if (monto <= 0) continue;

            const yaEnviado = enviados[f.id_factura] && enviados[f.id_factura].includes(nivel);
            if (!yaEnviado) {
                const jid = formatWhatsApp(f.celular);
                if (jid) {
                    const fecha = new Date(f.fecha_reg).toISOString().split('T')[0];
                    let msg = "";
                    if (nivel >= 60) {
                        msg = `🧾 *AVISO DE PAGO PENDIENTE*\n\nHola *${f.nombres}*, la factura *N° ${f.nro_factura}* emitida el *${fecha}* ya superó los 60 días de vencida con un saldo de *$${monto.toFixed(2)}*.\n\nEl retraso en el pago afecta la rotación de nuestros productos. Le agradecemos realizar el pago a la mayor brevedad posible. 🚗`;
                    } else {
                        msg = `🧾 *RECORDATORIO DE PAGO*\n\nHola *${f.nombres}*, le recordamos amablemente que la factura *N° ${f.nro_factura}* con fecha *${fecha}* presenta un saldo pendiente de *$${monto.toFixed(2)}*.\n\nLe agradecemos gestionar el pago para mantener su cuenta al día. 🚗`;
                    }
                    await safeSendMessage(jid, { text: msg });
                }
                await notificador.marcarRecordatorio(f.id_factura, nivel);
                await sleep(1000);
            }
        }
    } catch (e) { console.log("[RECORDATORIO] Error:", e.message); }
}

async function checkVendedoresRecordatorio() {
    if (!isBotReady()) return;
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
            if (f.dias_vencida < 30) continue;
            let monto = (parseFloat(f.total) - parseFloat(f.abono_factura || 0)) / (parseFloat(f.porcentaje) || 1);
            if (monto <= 0 || !f.celular_vendedor) continue;

            // REGLA DE NEGOCIO ESTRICTA: MANUEL FERRAZ
            if (f.vendedor_nombre && f.vendedor_nombre.toUpperCase() === 'MANUEL FERRAZ') {
                monto = monto / 0.80;
            }

            const key = f.celular_vendedor.toString().replace(/\D/g, '');
            if (!vendedoresMap[key]) {
                vendedoresMap[key] = { nombre: f.vendedor_nombre || 'Vendedor', jid: formatWhatsApp(f.celular_vendedor), facturas: [] };
            }
            vendedoresMap[key].facturas.push(`🔹 *N° ${f.nro_factura}* - ${f.nombres} - $${monto.toFixed(2)} (${f.dias_vencida} días)`);
        }

        for (const key of Object.keys(vendedoresMap)) {
            const v = vendedoresMap[key];
            if (!v.jid || v.facturas.length === 0) continue;
            const msg = `📢 *RESUMEN DE CLIENTES VENCIDOS*\n\nVendedor: *${v.nombre}*\n\n${v.facturas.join('\n')}\n\nLe recordamos la importancia de gestionar estos cobros.`;
            await safeSendMessage(v.jid, { text: msg });
            await sleep(1000);
        }
        await notificador.marcarEnvioVendedor();
    } catch (e) { console.log("[VENDEDORES] Error:", e.message); }
}

async function actualizarDolar() {
    try {
        const resOficial = await axios.get('https://ve.dolarapi.com/v1/dolares/oficial', { timeout: 7000 });
        if (resOficial.data) dolarInfo.bcv = parseFloat(resOficial.data.promedio).toFixed(2);
        const resParalelo = await axios.get('https://ve.dolarapi.com/v1/dolares/paralelo', { timeout: 7000 });
        if (resParalelo.data) dolarInfo.paralelo = parseFloat(resParalelo.data.promedio).toFixed(2);
    } catch (e) {}
}

// ==========================================
// CONTROLADOR DEL BOT (STARTBOT)
// ==========================================

async function startBot() {
    if (socketBot) {
        try { socketBot.removeAllListeners(); socketBot.end(undefined); } catch (e) {}
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
                setInterval(() => { if (!isBotReady() && socketBot) startBot(); }, 300000);
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
            const sesion = await getSesion(from);

            if (msg.key.fromMe) {
                const textMe = normalizar(msg.message.conversation || msg.message.extendedTextMessage?.text || "");
                if (textMe === '!bot') {
                    await setModo(from, 'bot');
                    await safeSendMessage(from, { text: "🤖 Bot reactivado." });
                } else {
                    await setModo(from, 'humano');
                }
                return;
            }

            if (sesion && sesion.modo === 'humano' && !isAdmin) return;

            const pushName = msg.pushName || "Usuario";
            const rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
            if (!rawText) return;
            const text = normalizar(rawText);

            await guardarMensaje(from, 'user', rawText);

            // --- LÓGICA DE IDENTIFICACIÓN (RIF VS PRODUCTO) ---
            
            // 1. Si es Admin y parece un RIF (Empieza por letra o es muy largo)
            const pareceRIF = /^[VJGJE]/i.test(rawText) || (rawText.length >= 8 && /^\d+$/.test(rawText));
            
            if (isAdmin && pareceRIF) {
                // Antes de tratarlo como RIF, verificamos si es un código de producto exacto
                const [esProducto] = await pool.execute("SELECT producto FROM tab_productos WHERE producto = ?", [rawText.toUpperCase()]);
                
                if (esProducto.length === 0) {
                    const rifLimpio = limpiarRIF(rawText);
                    const c = await buscarCliente(rifLimpio);
                    if (c) {
                        await guardarUsuario(from, rifLimpio, c.id_cliente);
                        const facturas = await obtenerDetalleFacturas(c.id_cliente);
                        let totalP = 0; 
                        let list = `⭐ *ESTADO DE CUENTA (ADMIN)*\nCliente: ${c.nombres}\nRIF: ${rifLimpio}\n\n`;
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
                        // Si parece RIF pero no existe, informamos (Solo si no es un código de producto)
                        return await safeSendMessage(from, { text: "❌ No se encontró ningún cliente con ese RIF." });
                    }
                }
            }

            // 2. PAGO MOVIL FIJO
            if (text.includes("pago movil") || text.includes("datos de pago")) {
                return await safeSendMessage(from, { text: "🏦 *DATOS PAGO MÓVIL:*\n\n📞 Teléfono: 04142423348\n🆔 RIF: V12959286\n🏛️ Banco: Banesco" });
            }

            // 3. COMANDOS ADMIN
            if (isAdmin) {
                if (text === 'dolar') {
                    await actualizarDolar();
                    return await safeSendMessage(from, { text: `💵 BCV: ${dolarInfo.bcv}\n📈 Paralelo: ${dolarInfo.paralelo}` });
                }
            }

            // 4. MENU Y SALDOS
            if (text === '2' || text === 'saldo' || text === 'estado de cuenta') {
                const targetID = sesion?.id_cliente_int;
                if (!targetID) return await safeSendMessage(from, { text: "Para consultar su saldo, por favor envíe su *RIF* primero." });
                const facturas = await obtenerDetalleFacturas(targetID);
                if (facturas.length === 0) return await safeSendMessage(from, { text: "✅ No posee facturas pendientes." });
                let totalP = 0; let listado = "*📄 FACTURAS PENDIENTES:*\n\n";
                facturas.forEach(f => {
                    const monto = (f.total - f.abono_factura) / (f.porcentaje || 1);
                    totalP += monto;
                    const fReg = new Date(f.fecha_reg).toISOString().split('T')[0];
                    const params = `id_factura=${f.id_factura}&nro_factura=${f.nro_factura}&fecha_reg=${fReg}&total=${f.total}&abono_factura=${f.abono_factura}&nombres=${encodeURIComponent(f.nombres.trim())}&nombre=${encodeURIComponent(f.nombre_vendedor.trim())}&direccion=${encodeURIComponent(f.direccion.trim())}&cedula=${f.cedula.trim()}&celular=${encodeURIComponent(f.celular.trim())}&telefono=${encodeURIComponent(f.telefono.trim())}&id_cliente=${f.id_cliente}&zona=${encodeURIComponent(f.zona.trim())}&descuento=${f.descuento}&total_desc=${f.total_desc}`;
                    listado += `🔸 *#${f.nro_factura}* | $${monto.toFixed(2)}\n📄 PDF: https://one4cars.com/sevencorp/factura_full_reporte_web.php?${params}\n\n`;
                });
                listado += `💰 *TOTAL A PAGAR: $${totalP.toFixed(2)}*`;
                return await safeSendMessage(from, { text: listado });
            }

            if (text === 'menu' || text === 'hola' || text === 'buen dia') {
                const vend = await buscarVendedor(from, pushName);
                const nombre = vend ? vend.nombre : pushName;
                return await safeSendMessage(from, { text: `¡Hola *${nombre}*! 😊\n\n${MENU_TEXT}` });
            }

            // 5. BÚSQUEDA DE PRODUCTOS (CON FILTRADO DE RELEVANCIA MÁXIMA)
            const prods = await buscarProductoPorTexto(rawText);
            if (prods) {
                const saludos = [
                    "Saludos estimado, gracias por tu consulta puedo recomendarte estos artículos: 👇",
                    "¡Hola! He buscado en nuestro inventario y creo que esto es lo que buscas: 👇",
                    "Con gusto le ayudo. Aquí tienes las mejores opciones disponibles: 👇",
                    "Hola, un placer saludarle. He encontrado estos productos que coinciden: 👇"
                ];
                await safeSendMessage(from, { text: saludos[Math.floor(Math.random() * saludos.length)] });
                await sleep(1500);
                for (const p of prods) {
                    const caption = `📦 *CÓDIGO: ${p.producto}*\n💰 *Precio Final: $${parseFloat(p.precio_final).toFixed(2)}*\n📝 ${p.descripcion}\n🔗 Ficha: https://one4cars.com/producto_general.php?cod=${p.producto}&tipo=${encodeURIComponent(p.tipo)}`;
                    const imgUrl = `https://one4cars.com/imagen/${p.producto}.jpg`;
                    try {
                        await socketBot.sendMessage(from, { image: { url: imgUrl }, caption: caption });
                    } catch (e) { await safeSendMessage(from, { text: caption }); }
                    await sleep(1500);
                }
                return;
            }

            // 6. FALLBACK
            const conversational = ['si', 'no', 'ok', 'gracias', 'entendido', 'vale'];
            if (!conversational.includes(text) && rawText.length < 120) {
                await safeSendMessage(from, { text: "Lo siento, no logré entender tu solicitud. 😕 ¿Podrías darme más detalles o escribir *menu*?" });
            }

        } catch (e) { console.log("[MSG] Error:", e.message); }
    });
}

// ==========================================
// SERVIDOR HTTP (ADMIN PANEL)
// ==========================================

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const query = Object.fromEntries(parsedUrl.searchParams.entries());
    const header = `<nav class="navbar navbar-dark bg-dark mb-4 shadow"><div class="container"><a class="navbar-brand fw-bold" href="/">ONE4CARS ADMIN</a></div></nav>`;

    if (parsedUrl.pathname === '/') {
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><meta http-equiv="refresh" content="30"><title>Admin ONE4CARS</title></head><body style="background-color: #f4f7f6;">${header}<div class="container text-center"><div class="card shadow-lg p-4 mx-auto" style="max-width: 500px; border-radius: 15px;"><h4 class="mb-3">Estado del Bot</h4><div class="my-4">${qrCodeData.startsWith('data') ? `<img src="${qrCodeData}" class="img-fluid rounded" style="max-width: 250px;">` : `<h2 class="text-success">${qrCodeData}</h2>`}</div><p>BCV: ${dolarInfo.bcv} | Paralelo: ${dolarInfo.paralelo}</p><div class="d-grid gap-2"><a href="/cobranza" class="btn btn-primary">PANEL DE COBRANZA</a><a href="/marketing-panel" class="btn btn-info text-white">PANEL DE MARKETING</a><a href="/notificador-estado" class="btn btn-secondary text-white">NOTIFICADOR</a><a href="/recordatorio-estado" class="btn btn-warning text-dark">RECORDATORIOS</a></div></div></div></body></html>`);
    } else if (parsedUrl.pathname === '/cobranza') {
        const v = await cobranza.obtenerVendedores();
        const z = await cobranza.obtenerZonas();
        const d = await cobranza.obtenerListaDeudores(query);
        res.end(await cobranza.generarHTML(v, z, d, header, query));
    } else if (parsedUrl.pathname === '/marketing-panel') {
        const v = await marketingModulo.obtenerVendedores();
        const z = await marketingModulo.obtenerZonas();
        const c = await marketingModulo.obtenerClientesMarketing(query);
        res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
        res.end(await marketingModulo.generarHTMLMarketing(c, v, z, header, query));
    } else if (parsedUrl.pathname === '/marketing-preview') {
        let sql = "SELECT id_cliente, nombres, celular FROM tab_clientes WHERE celular IS NOT NULL AND celular != ''";
        const params = [];
        if (query.vendedor) { sql += " AND vendedor = ?"; params.push(query.vendedor); }
        if (query.zona) { sql += " AND zona = ?"; params.push(query.zona); }
        const [clientes] = await pool.execute(sql, params);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(clientes));
    } else if (parsedUrl.pathname === '/enviar-marketing' && req.method === 'POST') {
        let b = ''; req.on('data', c => b += c);
        req.on('end', async () => {
            const data = JSON.parse(b);
            for (const id of data.clientes) {
                const [rows] = await pool.execute("SELECT * FROM tab_clientes WHERE id_cliente=?", [id]);
                if (rows[0]) {
                    const c = rows[0];
                    const jid = formatWhatsApp(c.celular);
                    if (data.tipo === 'precios') {
                        await safeSendMessage(jid, { document: { url: PDF_URL_CATALOGO }, fileName: 'Catalogo-ONE4CARS.pdf', mimetype: 'application/pdf', caption: `¡Hola *${c.nombres}*! Catálogo actualizado.` });
                    } else {
                        await safeSendMessage(jid, { text: data.mensaje });
                    }
                    await randomDelay();
                }
            }
            res.end("OK");
        });
    } else if (parsedUrl.pathname === '/enviar-cobranza' && req.method === 'POST') {
        let b = ''; req.on('data', c => b += c);
        req.on('end', async () => {
            const data = JSON.parse(b);
            for (const id_cliente of data.facturas) {
                const [facturas] = await pool.execute("SELECT f.*, c.nombres, c.celular FROM tab_facturas f JOIN tab_clientes c ON f.id_cliente = c.id_cliente WHERE f.id_cliente = ? AND f.pagada = 'NO' AND f.anulado = 'no'", [id_cliente]);
                for (const f of facturas) {
                    const jid = formatWhatsApp(f.celular);
                    const saldoBs = (f.total - f.abono_factura) / (f.porcentaje || 1);
                    const msg = `Hola *${f.nombres}* 🚗, factura #${f.nro_factura} pendiente.\nSaldo: Bs. *${saldoBs.toLocaleString('es-VE')}*.\nPor favor gestione su pago.`;
                    await safeSendMessage(jid, { text: msg });
                    await randomDelay();
                }
            }
            res.end("OK");
        });
    } else if (parsedUrl.pathname === '/reset-sesion') {
        if (fs.existsSync('auth_info')) fs.rmSync('auth_info', { recursive: true, force: true });
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="5;url=/"></head><body><h3>✅ Sesión borrada. Reiniciando...</h3></body></html>`);
    } else if (parsedUrl.pathname === '/notificador-estado') {
        const total = await notificador.obtenerFacturasNoNotificadasCount();
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"></head><body class="bg-light">${header}<div class="container mt-5"><h3>📬 Notificador: ${total} pendientes</h3><a href="/" class="btn btn-secondary">Volver</a></div></body></html>`);
    } else if (parsedUrl.pathname === '/recordatorio-estado') {
        const facturas = await notificador.obtenerFacturasVencidas();
        const enviados = await notificador.obtenerRecordatoriosEnviados();
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"></head><body class="bg-light">${header}<div class="container mt-5"><h3>📅 Recordatorios</h3><table class="table table-sm"><thead><tr><th>Factura</th><th>Cliente</th><th>Días</th><th>Estado</th></tr></thead><tbody>${facturas.map(f => `<tr><td>${f.nro_factura}</td><td>${f.nombres}</td><td>${f.dias_vencida}</td><td>${(enviados[f.id_factura]) ? '✅' : '⏳'}</td></tr>`).join('')}</tbody></table><a href="/" class="btn btn-secondary">Volver</a></div></body></html>`);
    }
});

server.listen(PORT, '0.0.0.0', async () => {
    await initDB();
    startBot();
    actualizarDolar();
    setInterval(actualizarDolar, 3600000);
});
