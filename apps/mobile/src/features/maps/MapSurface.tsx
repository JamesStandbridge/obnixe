import { useImperativeHandle, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import { Camera, GeoJSONSource, Images, Layer, Map } from "@maplibre/maplibre-react-native";
import type { CameraRef, StyleSpecification } from "@maplibre/maplibre-react-native";
import type { MapSurfaceProps } from "@/features/maps/surface";
import { headingImage } from "@/features/maps/trackLayers";

const overlayImages = { [headingImage]: { source: require("../../../public/maps/overlay/heading.png"), sdf: true } };

export function MapSurface({ mapStyle, fallbackStyle, initialCamera, overlays = [], interactive = true, onUserGesture, onViewChanged, ref }: MapSurfaceProps) {
  const camera = useRef<CameraRef>(null);
  const [failedStyle, setFailedStyle] = useState<StyleSpecification | string | null>(null);

  useImperativeHandle(ref, () => ({
    moveTo: ({ center, zoom, bearing, durationMs }) =>
      camera.current?.easeTo({ center: [center[0], center[1]], ...(zoom === undefined ? {} : { zoom }), ...(bearing === undefined ? {} : { bearing }), duration: durationMs, easing: "linear" }),
  }));

  return (
    <Map
      style={StyleSheet.absoluteFill}
      mapStyle={failedStyle === mapStyle ? fallbackStyle : mapStyle}
      attribution={false}
      logo={false}
      compass={false}
      scaleBar={false}
      dragPan={interactive}
      touchZoom={interactive}
      doubleTapZoom={interactive}
      doubleTapHoldZoom={interactive}
      touchRotate={interactive}
      touchPitch={false}
      onDidFailLoadingMap={() => setFailedStyle(mapStyle)}
      onRegionWillChange={(event) => {
        if (event.nativeEvent.userInteraction) onUserGesture?.();
      }}
      onRegionDidChange={(event) => onViewChanged?.({ bounds: event.nativeEvent.bounds, zoom: event.nativeEvent.zoom })}
    >
      <Camera ref={camera} initialViewState={{ center: [initialCamera.center[0], initialCamera.center[1]], zoom: initialCamera.zoom }} />
      <Images images={overlayImages} />
      {overlays.map((overlay) => (
        <GeoJSONSource key={overlay.id} id={overlay.id} data={overlay.data} lineMetrics={overlay.lineMetrics}>
          {overlay.layers.map((layer) => (
            <Layer key={layer.id} {...layer} />
          ))}
        </GeoJSONSource>
      ))}
    </Map>
  );
}
