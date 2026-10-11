import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="pt-BR">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover" />
        <meta name="theme-color" content="#06100C" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="EcoTracker" />
        <meta name="description" content="EcoTracker — créditos ambientais fracionados com rastreabilidade e acompanhamento da aposentadoria." />
        <link rel="manifest" href="/app/manifest.webmanifest" />
        <link rel="icon" href="/app/ecotracker-app-icon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/app/ecotracker-app-icon.svg" />
        <ScrollViewStyleReset />
      </head>
      <body>{children}
        <script
          dangerouslySetInnerHTML={{
            __html: "if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/app/sw.js',{scope:'/app/'}).catch(function(){})})}",
          }}
        />
      </body>
    </html>
  );
}
