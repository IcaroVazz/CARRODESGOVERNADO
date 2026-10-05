# Carrinho de Supermercado Desgovernado

Jogo endless runner 3D feito com HTML, CSS, JavaScript e Three.js. Não usa build step.

## Executar

Abra um terminal nesta pasta e rode:

```powershell
node server.js
```

Depois abra `http://localhost:8000` no navegador. A página usa módulos JavaScript e carrega Three.js por CDN, então precisa de um servidor HTTP local e conexão à internet na primeira carga.

## Controles

- `A` / `D` ou `←` / `→`: virar
- `S` / `↓`: reduzir velocidade
- `Espaço`: freio e derrapagem
- Mouse: mover para os lados
- Celular: botões nas laterais inferiores da tela
- A velocidade aumenta conforme a pontuação sobe; uma batida encerra a descida.

## Modelos 3D e cenário

O carrinho e o personagem usam os modelos existentes em `3DMODELS/`. Os obstáculos usam `caixa.glb`, `feno.glb` e `pedra.glb`, ajustados para a pista. As laterais têm casas e prédios procedurais em Three.js, apoiados em terreno contínuo e reciclados com os segmentos da estrada.

- **PSX shopping cart** — zynxeror, [Sketchfab](https://sketchfab.com/3d-models/psx-shopping-cart-96534b56f0d9487db08f00f1f9301fa1)
- **Stickman Cool Guy** — Bogdan Strielecki, [Sketchfab](https://sketchfab.com/3d-models/stickman-cool-guy-2a3ff6d431c14d7b841eeeff56c98a06)

O carrinho e o personagem estão publicados sob licença [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
# CARRODESGOVERNADO
