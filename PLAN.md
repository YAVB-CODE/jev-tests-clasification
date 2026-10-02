# Plan — Jev Classify Lab (GPT vs Jev clasificando conceptos de factura → PUC)

## Objetivo

App web (React + Node) con **pantalla dividida**: a la izquierda **GPT** (OpenAI, LLM tradicional) y a la derecha
**Jev** (modelo «System One» vía [OpenCode Zen](https://opencode.ai/docs/zen), `POST https://opencode.ai/zen/v1/systemone`)
clasifican **los mismos conceptos de facturas de compra (Colombia)** en **subcuentas del PUC** (Decreto 2650/1993).
Al terminar se compara quién clasificó mejor en tres pilares:

| Pilar | Qué mide |
| --- | --- |
| **Score** | Acierto exacto vs. etiqueta esperada, acierto por grupo (cuenta de 4 dígitos), macro-F1, precisión/recall por categoría, matriz de confusión, acierto por dificultad |
| **Confiabilidad** | Calibración de la confianza (Brier, ECE, diagrama de confiabilidad, AUROC confianza→acierto), errores sobreconfiados, % respuestas válidas, consistencia entre repeticiones |
| **Tiempo** | Latencia por concepto extremo a extremo y del proveedor (media, p50, p90, p95), tiempo total del lote, throughput |
| *(info)* Costo | Tokens y USD |

## Arquitectura

```
src/
  shared/      contracts.ts (CONGELADO: tipos de dominio, API y registros), task.ts (texto canónico idéntico para ambos motores)
  data/        puc-colombia.ts (dataset semilla), importDataset.ts (CSV/JSON), storage.ts (localStorage)
  metrics/     stats, scoring, calibration, timing, compute (por carril), compare (veredicto), format
  engines/     RemoteEngine (POST /api/classify), MockEngine (simulado), health/models
  bench/       runner.ts (pool de concurrencia por carril), store.ts (zustand)
  components/  layout/, lane/, compare/, detail/, dataset/, quick/
server/
  env.ts, models.ts, pricing.ts, validate.ts, app.ts, index.ts, smoke.ts
  adapters/    common.ts, gpt.ts (OpenAI structured outputs + logprobs), jev.ts (OpenCode Zen /v1/systemone), index.ts
```

API: `GET /api/health`, `GET /api/models`, `POST /api/classify { engine, model?, task, item }` → `ClassifyResult` (nunca lanza).
Puertos: API 8788, Vite 5174 (para no chocar con jev-tests).

## Reglas de equidad (no negociables)

1. **Mismo texto**: instrucciones, pregunta y criterios de cada categoría salen de `src/shared/task.ts` para ambos motores.
2. **Mismo concepto**: el item se serializa una sola vez (`serializeConcept`) — sin `id` ni etiqueta esperada.
3. **El servidor nunca recibe la etiqueta esperada**; la calificación ocurre en el cliente.
4. Mismo timeout, misma política de reintentos y misma concurrencia por carril; ambos carriles arrancan a la vez.
5. Concurrencia total ≤ 6 (límite de conexiones HTTP/1.1 del navegador) → máx. 3 por carril, para no inflar latencias.
6. Las API keys viven solo en el backend; nunca llegan al navegador.

## Tareas

Complejidad → modelo del subagente: **Alta → Opus 5.5**, **Media / Baja → Sonnet**.

| # | Fase | Tarea | Complejidad | Modelo | Depende de |
| --- | --- | --- | --- | --- | --- |
| T1 | 1 Fundaciones | Scaffold: Vite+React+TS+Tailwind, Express+tsx, Vitest, oxlint, tsconfigs, scripts, `.env` (keys copiadas de jev-tests), `npm install` | Baja | Sonnet | — |
| T2 | 1 Fundaciones | Contrato congelado (`contracts.ts`) + texto canónico y validación de tareas (`task.ts`) con tests | Alta | Opus | — |
| T3 | 2 Núcleo | Base del servidor: `env.ts`, `models.ts`, `pricing.ts`, `adapters/common.ts` (interfaz + helpers), stubs de `gpt.ts`/`jev.ts` | Media | Sonnet | T1, T2 |
| T4 | 2 Núcleo | Dataset semilla PUC (≈22 subcuentas, 60 conceptos etiquetados por dificultad) + importador CSV/JSON + storage | Media | Sonnet | T1, T2 |
| T5 | 2 Núcleo | Métricas puras: score, calibración, tiempo, costo, consistencia, comparación y veredicto por pilar | Alta | Opus | T1, T2 |
| T6 | 2 Núcleo | Motor del benchmark en cliente: engines remoto/simulado, runner con pool y timeouts, store zustand | Alta | Opus | T1, T2 |
| T7 | 3 Modelos | Adaptador GPT: structured outputs (enum de categorías + confianza), confianza por logprobs, modelos de razonamiento, reintentos, costo | Alta | Opus | T3 |
| T8 | 3 Modelos | Adaptador Jev (OpenCode Zen): pregunta `choice`, probabilidades/confianza nativa, reintentos, listado de modelos, prueba real | Alta | Opus | T3 |
| T9 | 3 Modelos | API Express: rutas, validación (descarta etiqueta), abort por desconexión, servir `dist/`, script `smoke` | Media | Sonnet | T3 |
| T10 | 4 UI | Pantalla dividida: header, barra de control, paneles de carril en vivo (KPIs, progreso, feed) | Media | Sonnet | T5, T6 |
| T11 | 4 UI | Panel de comparación: veredicto, tabla por pilar, diagrama de confiabilidad, latencias, acierto por dificultad | Media | Sonnet | T5, T6 |
| T12 | 4 UI | Detalle por concepto (GPT vs Jev vs esperado, filtros), confusiones y exportación JSON/CSV | Media | Sonnet | T5, T6 |
| T13 | 4 UI | Gestor de dataset (ver/editar/importar) + «Prueba rápida» de un concepto con ambos motores | Media | Sonnet | T4, T6 |
| T14 | 5 Cierre | Integración E2E en vivo: benchmark real con ambas keys, corrección de bugs de integración | Media | Sonnet | T7–T13 |
| T15 | 5 Cierre | Revisión final: equidad, corrección de métricas, seguridad de keys, calidad | Alta | Opus | T14 |
| T16 | 5 Cierre | README en español (uso, métricas, equidad, cómo agregar datasets) | Baja | Sonnet | T14 |

Paralelismo: T1‖T2 → (T3‖T4‖T5‖T6) → T7‖T8‖T9 en cuanto termina T3, y T10‖T11‖T12‖T13 en cuanto terminan T5/T6 → T14 → T15‖T16.

## Estado

| # | Estado |
| --- | --- |
| T1–T16 | ✅ completada |

Verificación final (2026-10-02): `npm test` 597/597, `tsc -b` limpio, `oxlint` limpio, `npm run build` OK.
Archivos de interfaz escritos por el orquestador para paralelizar la UI: `src/components/ui/theme.ts` y `src/components/metrics/hooks.ts`.
Todas las notas de revisión quedaron resueltas en T15 (ver README para el detalle de uso, métricas y equidad).
