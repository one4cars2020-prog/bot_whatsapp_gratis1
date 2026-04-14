const mysql = require('mysql2/promise');
const fs = require('fs');

const dbConfig = {
    host: 'one4cars.com',
    user: 'juant200_one4car',
    password: 'Notieneclave1*',
    database: 'juant200_venezon'
};

async function enviarListaPrecios(sock, listaTelefonos) {
    const pdfPath = './sevencorpweb/uploads/precios/Catalogo - ONE4CARS_compressed.pdf';
    
    for (const tel of listaTelefonos) {
        const jid = `${tel}@s.whatsapp.net`;
        try {
            await sock.sendMessage(jid, { 
                document: fs.readFileSync(pdfPath), 
                fileName: 'Catalogo-ONE4CARS.pdf',
                mimetype: 'application/pdf',
                caption: 'Aquí tienes nuestra lista de precios actualizada. 🚀'
            });
            await new Promise(r => setTimeout(r, 3000)); // Delay anti-spam
        } catch (e) { console.log("Error enviando PDF a", tel); }
    }
}

async function enviarPromoPersonalizada(sock, clientesIds) {
    const conn = await mysql.createConnection(dbConfig);
    
    for (const id of clientesIds) {
        const [rows] = await conn.execute("SELECT * FROM tab_clientes WHERE id_cliente = ?", [id]);
        if (rows.length === 0) continue;
        const c = rows[0];
        
        const mensaje = `*🛠️ ¡Tu Negocio, al Máximo Nivel con ONE4CARS!*

¡Hola *${c.nombres}*! 👋

Recibe un cordial saludo de la gerencia de ventas de *ONE4CARS*.

Tu negocio es muy valioso para nosotros. Somos distribuidores exclusivos de ONE4CARS:

*📦 Repuestos Clave:*
• *Filtración:* Aceite y Gasolina.
• *Motor:* Correas, Poleas, Crucetas.
• *Chasis:* Rodamientos, Tren Delantero.
• *Electricidad:* Bujías, Bombas de Gasolina.

---
*🌐 Acceso a tu Portal Mayorista:*
*Enlace:* https://one4cars.com/mayoristas
*LOGIN:* ${c.usuario}
*PASSWORD:* ${c.clave || 'Consulte con su vendedor'}

---
*🚀 Tu Página Web Personalizada:*
➡️ https://www.one4cars.com/${c.usuario}

Un abrazo grande.
El equipo de ONE4CARS.`;

        try {
            await sock.sendMessage(`${c.telefono}@s.whatsapp.net`, { text: mensaje });
            await new Promise(r => setTimeout(r, 3000));
        } catch (e) { console.log("Error enviando promo a", c.telefono); }
    }
    await conn.end();
}

module.exports = { enviarListaPrecios, enviarPromoPersonalizada };
