const mysql = require('mysql2/promise');

const dbConfig = {
    host: 'one4cars.com',
    user: 'juant200_one4car',
    password: 'Notieneclave1*',
    database: 'juant200_venezon'
};

async function obtenerFacturasNoNotificadas() {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute(
        "SELECT id_factura, nro_factura, nombres, celular, total, fecha_reg, id_cliente FROM tab_facturas WHERE whatsapp_notificado = 'NO' AND anulado = 'no' ORDER BY id_factura ASC"
    );
    await conn.end();
    return rows;
}

async function marcarNotificada(id_factura) {
    const conn = await mysql.createConnection(dbConfig);
    await conn.execute("UPDATE tab_facturas SET whatsapp_notificado = 'SI' WHERE id_factura = ?", [id_factura]);
    await conn.end();
}

async function obtenerFacturasNoNotificadasCount() {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute("SELECT COUNT(*) as total FROM tab_facturas WHERE whatsapp_notificado = 'NO' AND anulado = 'no'");
    await conn.end();
    return rows[0].total;
}

module.exports = {
    obtenerFacturasNoNotificadas,
    marcarNotificada,
    obtenerFacturasNoNotificadasCount
};
