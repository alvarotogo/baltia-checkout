// api/crear-pedido.js
//
// Esta función recibe el precio calculado por la calculadora de Baltia
// y crea un "Draft Order" en Shopify con ese precio exacto. Devuelve la
// URL de pago (invoice_url) a la que el cliente debe ser redirigido.
//
// IMPORTANTE — Apps creadas desde el Dev Dashboard (a partir de 2026):
// Shopify ya no permite copiar un token fijo desde el admin. En su lugar,
// esta función pide un token nuevo en cada ejecución usando el método
// "client credentials grant": una llamada server-to-server con el
// Client ID y Client Secret de tu app.
//
// Variables de entorno necesarias (configúralas en el panel de Vercel,
// nunca las escribas aquí directamente):
//   SHOPIFY_STORE         → ej: togoanimalcare.myshopify.com
//   SHOPIFY_CLIENT_ID     → el "Client ID" de tu app en el Dev Dashboard
//   SHOPIFY_CLIENT_SECRET → el "Client Secret" (empieza por shpss_...)
 
// Token cacheado en memoria entre llamadas para no pedir uno nuevo cada vez
// (se reinicia si la función "duerme"; es solo una optimización, no crítico)
let cachedToken = null;
let cachedTokenExpiry = 0;
 
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry) {
    return cachedToken;
  }
 
  const tokenUrl = `https://${process.env.SHOPIFY_STORE}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.SHOPIFY_CLIENT_ID,
    client_secret: process.env.SHOPIFY_CLIENT_SECRET,
  });
 
  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
 
  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`No se pudo obtener el token de Shopify: ${errText}`);
  }
 
  const tokenData = await tokenRes.json();
  cachedToken = tokenData.access_token;
  // Los tokens de client_credentials suelen durar 24h; refrescamos a las ~23h
  cachedTokenExpiry = now + (23 * 60 * 60 * 1000);
 
  return cachedToken;
}
 
export default async function handler(req, res) {
  // CORS: estas cabeceras deben ir SIEMPRE primero, antes de cualquier
  // otra comprobación. El navegador manda una petición OPTIONS (preflight)
  // antes del POST real, y si no responde aquí con estas cabeceras,
  // el navegador bloquea la petición real con un error de CORS.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
 
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
 
  // Solo aceptamos peticiones POST a partir de aquí
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Método no permitido' });
  }
 
  try {
    const { prima, frecuencia, mascota } = req.body;
 
    // Validación básica del precio: nunca confiar ciegamente en lo que
    // llega del navegador. Ponemos límites razonables de seguridad.
    const precioMensual = parseFloat(prima);
    if (!precioMensual || precioMensual < 5 || precioMensual > 500) {
      return res.status(400).json({ error: 'Prima fuera de rango válido' });
    }
 
    const esAnual = frecuencia === 'anual';
    // Anual con 10% de descuento sobre el total de 12 meses
    const precioFinal = esAnual
      ? Math.round(precioMensual * 12 * 0.9 * 100) / 100
      : precioMensual;
 
    const tituloLinea = esAnual
      ? `Póliza Baltia — Plan Anual (10% dto.) — ${mascota?.nombre || 'Mascota'}`
      : `Póliza Baltia — Plan Mensual — ${mascota?.nombre || 'Mascota'}`;
 
    const notaPedido = [
      `Especie: ${mascota?.species === 'dog' ? 'Perro' : 'Gato'}`,
      `Raza: ${mascota?.breed || '—'}`,
      `Edad: ${mascota?.age || '—'} años`,
      `Peso: ${mascota?.weightKg || '—'} kg${mascota?.weightEstimated ? ' (estimado)' : ''}`,
      `Cobertura: Esencial`,
      `Nutrición: ${mascota?.nutDesc || '—'}`,
      `Frecuencia de pago: ${esAnual ? 'Anual (10% dto.)' : 'Mensual'}`,
      `Prima mensual base: ${precioMensual.toFixed(2)} €`,
    ].join('\n');
 
    // 1. Conseguir un token de acceso válido (client credentials grant)
    const accessToken = await getAccessToken();
 
    // 2. Usar ese token para crear el Draft Order
    //    NOTA: payload simplificado al mínimo (solo line_items + note),
    //    igual que el ejemplo oficial de Shopify, para descartar que
    //    campos opcionales (tags, requires_shipping, etc.) influyeran
    //    en el bloqueo por protected customer data.
    const shopifyUrl = `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01/draft_orders.json`;
 
    const draftOrderPayload = {
      draft_order: {
        line_items: [
          {
            title: tituloLinea,
            price: precioFinal.toFixed(2),
            quantity: 1,
          },
        ],
        note: notaPedido,
      },
    };
 
    const shopifyRes = await fetch(shopifyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify(draftOrderPayload),
    });
 
    if (!shopifyRes.ok) {
      const errText = await shopifyRes.text();
      console.error('Error de Shopify:', errText);
      return res.status(502).json({ error: 'Error al crear el pedido en Shopify' });
    }
 
    const data = await shopifyRes.json();
    const invoiceUrl = data.draft_order?.invoice_url;
 
    if (!invoiceUrl) {
      return res.status(502).json({ error: 'Shopify no devolvió URL de pago' });
    }
 
    return res.status(200).json({
      checkoutUrl: invoiceUrl,
      precioFinal,
      frecuencia: esAnual ? 'anual' : 'mensual',
    });
 
  } catch (err) {
    console.error('Error inesperado:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}
