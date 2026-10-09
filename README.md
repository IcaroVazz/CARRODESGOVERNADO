# Carrinho de Supermercado Desgovernado

Jogo endless runner 3D feito com HTML, CSS, JavaScript e Three.js. Não usa build step.

## Executar

Abra um terminal nesta pasta e rode:

```powershell
node server.js
```

Depois abra `http://localhost:8000` no navegador. A página usa módulos JavaScript e carrega Three.js por CDN, então precisa de um servidor HTTP local e conexão à internet na primeira carga.

## Multiplayer online

O multiplayer usa salas do Cloud Firestore e não exige conta nem login. Crie uma sala e compartilhe o código de seis caracteres; entram até seis jogadores, e o anfitrião inicia a corrida quando houver pelo menos dois. Cada participante aparece na pista e no placar. A corrida termina quando todos forem eliminados ou perderem a conexão.

Para habilitar salas sem autenticação, entre no CLI com uma conta que administra o projeto e publique as regras incluídas. Esse login serve só para configurar o Firebase; os jogadores continuam sem login:

```powershell
.\node_modules\.bin\firebase.cmd login --reauth
.\node_modules\.bin\firebase.cmd deploy --only firestore:rules --project carrinho-d139f
```

As regras permitem leitura e escrita pública apenas para os dados das salas multiplayer. Os IDs dos participantes ficam na sessão do navegador e não representam contas autenticadas. Como não há autenticação, qualquer pessoa com o código da sala pode alterar os dados daquela partida; use esse modo para corridas casuais, sem placar confiável contra trapaças.

As coleções são criadas automaticamente pelo Firestore quando o primeiro documento é gravado; não é necessário semear dados manualmente:

- `rooms/{codigo}` guarda o anfitrião, estado da corrida, participantes, vencedor e confirmações de revanche.
- `rooms/{codigo}/players/{id}` guarda presença e estado de cada carrinho (`x`, distância, velocidade, pontos, vida e ping).
- `players/{uid}` e `players/{uid}/runs/{runId}` guardam recordes pessoais opcionais do modo solo; as regras dessas coleções exigem a sessão anônima do Firebase.

## Controles

- `A` / `D` ou `←` / `→`: virar
- `S` / `↓`: reduzir velocidade
- Mouse: mover para os lados
- Celular: botões nas laterais inferiores da tela
- A velocidade aumenta conforme a pontuação sobe; uma batida encerra a descida.

## Modelos 3D e cenário

O personagem principal e todos os participantes do modo online usam `fast_boy_in_quill.glb`, com a animação incluída no modelo. Obstáculos e itens usam os modelos de `3DMODELS/`, ajustados para a pista. As laterais têm casas e prédios procedurais em Three.js, apoiados em terreno contínuo e reciclados com os segmentos da estrada.

- **Fast Boy in Quill** — Allen.Michael, [Sketchfab](https://sketchfab.com/3d-models/fast-boy-in-quill-d2850f50920e44889ada8053eef90b09), sob licença [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).

- **PSX shopping cart** — zynxeror, [Sketchfab](https://sketchfab.com/3d-models/psx-shopping-cart-96534b56f0d9487db08f00f1f9301fa1)

O carrinho está publicado sob licença [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
# CARRODESGOVERNADO
