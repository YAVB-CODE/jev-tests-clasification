import type { ReactNode } from 'react'
import { ENGINE_THEME } from '../ui/theme.ts'

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-zinc-900 uppercase dark:text-zinc-100">{title}</h3>
      <div className="space-y-1.5 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">{children}</div>
    </div>
  )
}

function Term({ children, className }: { children: ReactNode; className?: string }) {
  return <b className={className ?? 'font-semibold text-zinc-900 dark:text-zinc-100'}>{children}</b>
}

const LIST = 'list-disc space-y-1 pl-4 marker:text-zinc-400'

/** Collapsible explainer: what each lane does, the fairness rules and what each pillar measures. */
export function HowItWorks() {
  return (
    <details className="group rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 text-sm font-medium select-none hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-500 dark:hover:bg-zinc-800/50 [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-zinc-400 transition-transform group-open:rotate-90">
          ▶
        </span>
        ¿Cómo funciona?
        <span className="ml-1 hidden text-xs font-normal text-zinc-500 sm:inline dark:text-zinc-400">
          Qué hace cada carril, reglas de equidad y qué mide cada pilar
        </span>
      </summary>

      <div className="grid gap-x-8 gap-y-5 border-t border-zinc-200 px-4 py-4 min-[900px]:grid-cols-2 min-[1280px]:grid-cols-3 dark:border-zinc-800">
        <Block title="La idea">
          <p>
            Dos modelos reciben <Term>los mismos conceptos de facturas de compra de Colombia</Term> (por ejemplo «Servicio de energía periodo
            marzo») y cada uno debe elegir la subcuenta del <Term>PUC</Term> (Decreto 2650/1993) correcta entre una lista cerrada de opciones,
            indicando además qué tan seguro está.
          </p>
          <p>
            La respuesta correcta solo la conoce esta app: se compara en tu navegador cuando llega cada respuesta. El servidor nunca la recibe.
          </p>
        </Block>

        <Block title="Los dos carriles">
          <ul className={LIST}>
            <li>
              <Term className={`font-semibold ${ENGINE_THEME.gpt.text}`}>GPT</Term> (izquierda): modelo de OpenAI, un LLM tradicional. Responde con
              salida estructurada: la categoría elegida y la confianza que él mismo declara.
            </li>
            <li>
              <Term className={`font-semibold ${ENGINE_THEME.jev.text}`}>Jev</Term> (derecha): modelo «System One» servido por OpenCode Zen. Recibe
              una pregunta de elección y devuelve una probabilidad por opción; su confianza es la probabilidad de la opción elegida.
            </li>
            <li>
              <Term>Live</Term> llama a los modelos reales a través del backend. <Term>Simulado</Term> usa motores locales con parámetros ilustrativos:
              sirve para probar la pantalla, <Term>no mide nada real</Term>.
            </li>
          </ul>
        </Block>

        <Block title="Reglas de equidad">
          <ul className={LIST}>
            <li>
              <Term>Mismo texto</Term>: instrucciones, pregunta y criterios de cada categoría son idénticos para ambos motores.
            </li>
            <li>
              <Term>Mismo concepto</Term>: cada línea se serializa una sola vez, sin identificador ni etiqueta esperada, y llega igual a los dos.
            </li>
            <li>
              <Term>Misma cola</Term>: ambos carriles reciben los mismos conceptos en el mismo orden (semilla) y arrancan a la vez.
            </li>
            <li>
              <Term>Mismas condiciones</Term>: igual timeout, igual política de reintentos e igual concurrencia por carril (máx. 3).
            </li>
            <li>
              Las API keys viven solo en el backend; nunca llegan al navegador.
            </li>
          </ul>
        </Block>

        <Block title="Pilar 1 · Score">
          <p>
            Cuántos conceptos clasificó <Term>exactamente</Term> en la subcuenta correcta (acierto), con su intervalo de confianza al 95 %. Una
            respuesta inválida, un error o un timeout cuentan como fallo. El detalle agrega acierto por grupo, macro-F1 y matriz de confusión.
          </p>
        </Block>

        <Block title="Pilar 2 · Confiabilidad">
          <p>
            ¿Se puede creer en la confianza que declara el modelo? Compara lo seguro que dice estar con lo que realmente acierta.
          </p>
          <ul className={LIST}>
            <li>
              <Term>ECE</Term>: distancia promedio entre confianza y acierto real (0 = perfecta; menor es mejor).
            </li>
            <li>
              <Term>Brier</Term>: error cuadrático de la confianza frente al resultado (menor es mejor).
            </li>
            <li>
              <Term>% válidas</Term>: clasificaciones con una subcuenta válida (sin respuestas inválidas, errores ni timeouts).
            </li>
          </ul>
        </Block>

        <Block title="Pilar 3 · Tiempo">
          <p>
            Latencia por concepto de extremo a extremo, medida en el navegador: <Term>p50</Term> (la mitad responde más rápido que esto) y{' '}
            <Term>p95</Term> (el peor caso habitual), más el tiempo total del lote. El costo en tokens y USD es solo informativo y no entra en el
            veredicto.
          </p>
        </Block>

        <Block title="Cómo leer los carriles">
          <ul className={LIST}>
            <li>
              Las tres tarjetas se actualizan con cada respuesta. El <Term>feed en vivo</Term> muestra primero lo más reciente.
            </li>
            <li>
              <Term>✓</Term> acierto · <Term>✗</Term> error · <Term>!</Term> sin respuesta utilizable (inválida, error o timeout). Pulsa una fila
              para ver probabilidades, confianza nativa y la justificación del dataset.
            </li>
            <li>
              Si algún carril está en modo <Term>SIMULADO</Term>, el resultado se marca como ilustrativo: solo Live valida la comparación.
            </li>
          </ul>
        </Block>
      </div>
    </details>
  )
}
