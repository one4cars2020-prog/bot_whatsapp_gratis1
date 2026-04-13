const mysql = require('mysql2/promise');

const dbConfig = {
    host: 'one4cars.com',
    user: 'juant200_one4car',
    password: 'Notieneclave1*',
    database: 'juant200_venezon'
};

async function obtenerVendedores() {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute("SELECT DISTINCT vendedor FROM tab_clientes WHERE vendedor != '' ORDER BY vendedor ASC");
    await conn.end();
    return rows;
}

async function obtenerZonas() {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute("SELECT DISTINCT zona FROM tab_clientes WHERE zona != '' ORDER BY zona ASC");
    await conn.end();
    return rows;
}

async function buscarCliente(rif) {
    const conn = await mysql.createConnection(dbConfig);
    const [r] = await conn.execute("SELECT id_cliente, nombres FROM tab_clientes WHERE clave LIKE ? LIMIT 1", [`%${rif}%`]);
    await conn.end();
    return r[0] || null;
}

async function obtenerDetalleFacturasMaster(id) {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute("SELECT * FROM tab_facturas WHERE id_cliente=? AND pagada='NO' AND anulado='no'", [id]);
    await conn.end();
    return rows;
}

// 🔥 FIX EBENEZER + FILTRO ZONA + DÍAS MANUALES
async function obtenerListaDeudores(filtros) {
    const conn = await mysql.createConnection(dbConfig);
    let dias = parseInt(filtros.dias) || 0; // Días manuales desde el input
    
    let sql = `
        SELECT c.id_cliente, c.nombres, c.celular, c.zona, c.vendedor,
               GROUP_CONCAT(f.nro_factura SEPARATOR ', ') as nros,
               MAX(DATEDIFF(CURDATE(), f.fecha_reg)) as max_dias,
               SUM((f.total - f.abono_factura) / f.porcentaje) as total_deuda
        FROM tab_facturas f
        JOIN tab_clientes c ON f.id_cliente = c.id_cliente
        WHERE f.pagada = 'NO' AND f.anulado = 'no'
        AND DATEDIFF(CURDATE(), f.fecha_reg) >= ?
    `;
    
    let params = [dias];

    if (filtros.vendedor) {
        sql += " AND c.vendedor = ?";
        params.push(filtros.vendedor);
    }
    if (filtros.zona) {
        sql += " AND c.zona = ?";
        params.push(filtros.zona);
    }

    sql += " GROUP BY c.id_cliente ORDER BY max_dias DESC";

    const [rows] = await conn.execute(sql, params);
    await conn.end();
    return rows;
}

async function generarHTML(v, z, d, header, q) {
    return `<!DOCTYPE html><html><head><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"></head>
    <body class="bg-light">${header}<div class="container">
    <h3>Panel de Cobranza</h3>
    <form class="row g-2 mb-4" method="GET" action="/cobranza">
        <div class="col-md-2">
            <label class="small">Días Mora (Mínimo):</label>
            <input type="number" name="dias" class="form-control" value="${q.dias || 0}" placeholder="Ej: 60">
        </div>
        <div class="col-md-3">
            <label class="small">Vendedor:</label>
            <select name="vendedor" class="form-select">
                <option value="">Todos</option>
                ${v.map(sel => `<option value="${sel.vendedor}" ${q.vendedor === sel.vendedor ? 'selected' : ''}>${sel.vendedor}</option>`).join('')}
            </select>
        </div>
        <div class="col-md-3">
            <label class="small">Zona:</label>
            <select name="zona" class="form-select">
                <option value="">Todas</option>
                ${z.map(zona => `<option value="${zona.zona}" ${q.zona === zona.zona ? 'selected' : ''}>${zona.zona}</option>`).join('')}
            </select>
        </div>
        <div class="col-md-2 d-flex align-items-end">
            <button type="submit" class="btn btn-primary w-100">Filtrar</button>
        </div>
    </form>
    <table class="table bg-white shadow-sm table-hover">
        <thead class="table-dark"><tr><th>Cliente</th><th>Zona</th><th>Facturas</th><th>Mora Máx</th><th>Total Vencido</th></tr></thead>
        <tbody>${d.map(r=>`<tr><td>${r.nombres}</td><td>${r.zona}</td><td>${r.nros}</td><td>${r.max_dias} días</td><td>$${r.total_deuda.toFixed(2)}</td></tr>`).join('')}</tbody>
    </table></div></body></html>`;
}

module.exports = { obtenerVendedores, obtenerZonas, obtenerListaDeudores, generarHTML, buscarCliente, obtenerDetalleFacturasMaster };
