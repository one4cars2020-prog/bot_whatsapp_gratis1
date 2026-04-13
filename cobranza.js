const mysql = require('mysql2/promise');

const dbConfig = {
    host: 'one4cars.com',
    user: 'juant200_one4car',
    password: 'Notieneclave1*',
    database: 'juant200_venezon'
};

async function obtenerVendedores() {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute("SELECT DISTINCT vendedor FROM tab_clientes WHERE vendedor != ''");
    await conn.end();
    return rows;
}

async function obtenerZonas() {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute("SELECT DISTINCT zona FROM tab_clientes WHERE zona != ''");
    await conn.end();
    return rows;
}

// 🔥 FIX EBENEZER: Filtra individualmente cada factura por sus días de mora real
async function obtenerListaDeudores(filtros) {
    const conn = await mysql.createConnection(dbConfig);
    let dias = filtros.dias || 0;
    
    let sql = `
        SELECT c.id_cliente, c.nombres, c.celular,
               GROUP_CONCAT(f.nro_factura SEPARATOR ', ') as nros,
               MAX(DATEDIFF(CURDATE(), f.fecha_reg)) as max_dias,
               SUM((f.total - f.abono_factura) / f.porcentaje) as total_deuda
        FROM tab_facturas f
        JOIN tab_clientes c ON f.id_cliente = c.id_cliente
        WHERE f.pagada = 'NO' AND f.anulado = 'no'
        AND DATEDIFF(CURDATE(), f.fecha_reg) >= ?
    `;
    let params = [dias];
    if (filtros.vendedor) { sql += " AND c.vendedor = ?"; params.push(filtros.vendedor); }
    if (filtros.zona) { sql += " AND c.zona = ?"; params.push(filtros.zona); }
    
    sql += " GROUP BY c.id_cliente ORDER BY max_dias DESC";
    const [rows] = await conn.execute(sql, params);
    await conn.end();
    return rows;
}

async function generarHTML(v, z, d, header, q) {
    return `<!DOCTYPE html><html><head><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"></head>
    <body class="bg-light">${header}<div class="container">
    <h3>Panel de Cobranza</h3>
    <form class="row g-2 mb-4">
        <div class="col-3"><select name="dias" class="form-select"><option value="0">Todos</option><option value="30">Mora +30</option><option value="60">Mora +60</option></select></div>
        <div class="col-3"><select name="vendedor" class="form-select"><option value="">Vendedor: Todos</option>${v.map(v=>`<option>${v.vendedor}</option>`)}</select></div>
        <div class="col-3"><button class="btn btn-primary">Filtrar</button></div>
    </form>
    <table class="table bg-white shadow-sm">
        <thead><tr><th>Cliente</th><th>Facturas</th><th>Mora Máx</th><th>Monto Vencido</th></tr></thead>
        <tbody>${d.map(r=>`<tr><td>${r.nombres}</td><td>${r.nros}</td><td>${r.max_dias} días</td><td>$${r.total_deuda.toFixed(2)}</td></tr>`).join('')}</tbody>
    </table></div></body></html>`;
}

module.exports = { obtenerVendedores, obtenerZonas, obtenerListaDeudores, generarHTML };
