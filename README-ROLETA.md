# Roleta — versão de implementação (não validada em produção)

- 3 giros por CPF, todos os giros concedem bilhetes para o sorteio diário. Aproximadamente 45% dos giros concedem extras para domingo.
- Em cada giro, chance de 12% de prêmio de R$ 70 mil para quem ainda não ganhou (aproximadamente 32% de participantes em três giros, se houver estoque), limitado a 1.000 prêmios globais no Redis, sem limite diário. A reserva é atômica via EVAL/Lua. O prêmio é registrado como `aguardando_contato`.
- Necessárias variáveis na Vercel: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ROLETA_CPF_PEPPER e ADMIN_PASSWORD. Reutilizar o mesmo Redis e pepper nas novas implantações.
- O painel exporta histórico JSON e importa apenas participações sem prêmio monetário. Prêmios monetários não são importados para impedir inconsistência do estoque; para preservar vencedores, reutilize o mesmo Redis ou faça migração transacional auditada.
- Não existe integração com sistema oficial de emissão/numeração dos bilhetes ou de apuração; os bilhetes são registros de quantidade, não títulos oficialmente emitidos.
- A chamada de vídeo é uma orientação visual para contato humano, não uma chamada automática.
- A probabilidade de 12% é aplicada por giro a participantes ainda não premiados e é uma configuração inicial que deve coincidir com o regulamento.
- Antes de publicar, validar autorização/regulamento, estoque financeiro, testes reais de concorrência e segurança, integridade do Redis, autenticação do painel e os textos legados da página.

- O painel tem consulta de vencedores (IDs anonimizados), além de exportação JSON. A importação não restaura prêmios monetários: mantenha o mesmo Redis para preservar o estoque e o histórico de vencedores.
