// api/check-payment.js - Nova versão com AllowPay v2
const API_BASE = "https://allow-gi0i.onrender.com";
const API_KEY = "allow_apikey_ms1ng7i02bp";

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    try {
        const input = req.method === 'POST' ? req.body : req.query;
        const transactionId = input.transaction_id || '';
        const route = input.route || '';
        
        if (!transactionId) {
            return res.status(400).json({
                success: false,
                error: 'Transaction ID não fornecido'
            });
        }
        
        // Buscar o route salvo (se não veio na requisição)
        let routeToUse = route;
        if (!routeToUse) {
            // Tenta buscar do localStorage via header (opcional)
            // Ou usa safepix como padrão
            routeToUse = 'safepix';
        }
        
        // CONSULTAR STATUS NA ALLOWPAY V2
        const url = `${API_BASE}/api/v2/allowpay-seller/payment-status/${transactionId}?route=${routeToUse}`;
        
        console.log(`📊 Consultando status: ${url}`);
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ api_key: API_KEY })
        });
        
        if (!response.ok) throw new Error(`AllowPay HTTP ${response.status}`);
        const responseData = await response.json();
        
        if (responseData.error) {
            // Não inventar status pendente quando a API não encontra a transação.
            if (false && responseData.error.includes('não encontrado')) {
                return res.status(200).json({
                    success: true,
                    transaction_id: transactionId,
                    status: 'pending',
                    allowpay_status: 'pending',
                    amount: 0,
                    last_check: new Date().toISOString()
                });
            }
            throw new Error(responseData.error);
        }
        
        const allowPayStatus = responseData.status || 'unknown';
        const source = responseData.source || 'database';
        const amount = 0; // A API não retorna amount na consulta
        
        // MAPEAR STATUS para o formato que o front-end espera
        const statusMap = {
            'paid': 'paid',
            'approved': 'paid',
            'completed': 'paid',
            'confirmed': 'paid',
            'success': 'paid',
            'waiting_payment': 'pending',
            'pending': 'pending',
            'expired': 'expired',
            'failed': 'failed',
            'cancelled': 'canceled',
            'canceled': 'canceled',
            'declined': 'failed',
            'refunded': 'refunded',
            'chargeback': 'chargeback'
        };
        
        const status = statusMap[allowPayStatus] || 'unknown';
        
        console.log(`📊 Status mapeado: ${allowPayStatus} → ${status} (source: ${source})`);
        
        return res.status(200).json({
            success: true,
            transaction_id: transactionId,
            status: status,
            allowpay_status: allowPayStatus,
            source: source,
            amount: amount,
            last_check: new Date().toISOString(),
            response_data: responseData
        });
        
    } catch (error) {
        console.error('Falha real ao consultar pagamento na AllowPay:', error.message);
        return res.status(502).json({
            success: false,
            error: 'Falha ao consultar status do PIX na AllowPay',
            detail: error.message
        });
    }
}
