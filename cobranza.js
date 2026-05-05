const mysql = require('mysql2/promise');

// ===== CONFIGURACIÓN DE DB =====
const dbConfig = {
    host: 'one4cars.com',
    user: 'juant200_one4car',
    password: 'Notieneclave1*',
    database: 'juant200_venezon'
};

async function db() { 
    return await mysql.createConnection(dbConfig); 
}

// 1. Obtener lista de vendedores para el filtro
async function obtenerVendedores() {
    const conn = await db();
    const [rows] = await conn.execute("SELECT DISTINCT vendedor FROM tab_clientes WHERE vendedor != '' ORDER BY vendedor ASC");
    await conn.end();
    return rows;
}

// 2. Obtener lista de zonas para el filtro
async function obtenerZonas() {
    const conn = await db();
    const [rows] = await conn.execute("SELECT DISTINCT zona FROM tab_clientes WHERE zona != '' ORDER BY zona ASC");
    await conn.end();
    return rows;
}

// 3. Obtener clientes que tienen facturas pendientes (Deudores)
async function obtenerListaDeudores(filtros) {
    const conn = await db();
    
    let sql = `
        SELECT 
            c.id_cliente, 
            c.nombres, 
            c.celular, 
            c.vendedor, 
            c.zona, 
            SUM((f.total - f.abono_factura) / (f.porcentaje || 1)) as saldo_total,
            COUNT(f.id_factura) as cantidad_facturas
        FROM tab_clientes c
        JOIN tab_facturas f ON c.id_cliente = f.id_cliente
        WHERE f.pagada = 'NO' AND f.anulado = 'no'
    `;
    
    const params = [];
    if (filtros.vendedor) {
        sql += " AND c.vendedor = ?";
        params.push(filtros.vendedor);
    }
    if (filtros.zona) {
        sql += " AND c.zona = ?";
        params.push(filtros.zona);
    }

    sql += " GROUP BY c.id_cliente ORDER BY saldo_total DESC";
    
    const [rows] = await conn.execute(sql, params);
    await conn.end();
    return rows;
}

// 4. Generar el HTML del Panel de Cobranza con el botón de WhatsApp
async function generarHTML(vendedores, zonas, deudores, header, q) {
    return `<!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
        <title>Cobranza ONE4CARS</title>
        <style>
            .card-cobranza { border-radius: 15px; border: none; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            .st-sticky { position: sticky; top: 20px; }
        </style>
    </head>
    <body class="bg-light">
        ${header}
        <div class="container-fluid px-4">
            <div class="row">
                <!-- Panel de Control (Lado Izquierdo) -->
                <div class="col-md-3">
                    <div class="card card-cobranza p-4 st-sticky">
                        <h4>💰 Cobranzas</h4>
                        <hr>
                        <form method="GET" action="/cobranza" class="mb-4">
                            <label class="form-label small fw-bold">Vendedor:</label>
                            <select name="vendedor" class="form-select mb-3">
                                <option value="">Todos</option>
                                ${vendedores.map(v => `<option value="${v.vendedor}" ${q.vendedor === v.vendedor ? 'selected' : ''}>${v.vendedor}</option>`).join('')}
                            </select>

                            <label class="form-label small fw-bold">Zona:</label>
                            <select name="zona" class="form-select mb-3">
                                <option value="">Todas</option>
                                ${zonas.map(z => `<option value="${z.zona}" ${q.zona === z.zona ? 'selected' : ''}>${z.zona}</option>`).join('')}
                            </select>
                            <button type="submit" class="btn btn-dark w-100">Filtrar Deudores</button>
                        </form>
                        
                        <div class="alert alert-warning small">
                            <strong>Aviso:</strong> Al hacer clic en enviar, el bot enviará un recordatorio individual a cada cliente seleccionado.
                        </div>

                        <button onclick="enviarCobranzaMasiva()" class="btn btn-danger btn-lg w-100 shadow">🚀 Enviar Recordatorios WhatsApp</button>
                        <div id="status" class="mt-3 small text-center fw-bold"></div>
                    </div>
                </div>

                <!-- Tabla de Clientes (Lado Derecho) -->
                <div class="col-md-9">
                    <div class="card card-cobranza p-4">
                        <div class="d-flex justify-content-between align-items-center mb-3">
                            <h5>Clientes Pendientes: ${deudores.length}</h5>
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" id="selectAll" checked onclick="toggleAll()">
                                <label class="form-check-label">Seleccionar Todos</label>
                            </div>
                        </div>
                        <div class="table-responsive">
                            <table class="table table-hover align-middle">
                                <thead class="table-light">
                                    <tr>
                                        <th>Select</th>
                                        <th>Cliente</th>
                                        <th>Celular</th>
                                        <th>Zona</th>
                                        <th>Vendedor</th>
                                        <th>Facturas</th>
                                        <th>Deuda Total</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${deudores.map(d => `
                                    <tr>
                                        <td><input type="checkbox" class="client-check" value="${d.id_cliente}" checked></td>
                                        <td><strong>${d.nombres}</strong></td>
                                        <td>${d.celular}</td>
                                        <td><span class="badge bg-secondary">${d.zona}</span></td>
                                        <td>${d.vendedor}</td>
                                        <td>${d.cantidad_facturas}</td>
                                        <td class="text-danger fw-bold">$${parseFloat(d.saldo_total).toFixed(2)}</td>
                                    </tr>`).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <script>
            function toggleAll() {
                const check = document.getElementById('selectAll').checked;
                document.querySelectorAll('.client-check').forEach(c => c.checked = check);
            }

            async function enviarCobranzaMasiva() {
                const selected = Array.from(document.querySelectorAll('.client-check:checked')).map(c => c.value);
                if (selected.length === 0) return alert("Selecciona al menos un cliente.");

                const status = document.getElementById('status');
                status.innerHTML = "⏳ Enviando recordatorios... No cierres la página.";
                
                try {
                    const response = await fetch('/enviar-cobranza', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ facturas: selected })
                    });
                    
                    if (response.ok) {
                        status.innerHTML = "✅ ¡Recordatorios enviados con éxito!";
                        alert("Los mensajes han sido enviados a través del Bot.");
                    } else {
                        status.innerHTML = "❌ Error al enviar.";
                    }
                } catch (e) {
                    status.innerHTML = "❌ Error de conexión con el servidor.";
                }
            }
        </script>
    </body>
    </html>`;
}

// Exportamos las funciones para que index.js las use
module.exports = { 
    obtenerVendedores, 
    obtenerZonas, 
    obtenerListaDeudores, 
    generarHTML 
};
