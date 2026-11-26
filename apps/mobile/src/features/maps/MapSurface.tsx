import { useImperativeHandle, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import { Camera, GeoJSONSource, Images, Layer, Map } from "@maplibre/maplibre-react-native";
import type { CameraRef, StyleSpecification, ViewStateChangeEvent } from "@maplibre/maplibre-react-native";
import type { MapSurfaceProps, MapView } from "@/features/maps/surface";
import { headingImage } from "@/features/maps/trackLayers";

const overlayImages = { [headingImage]: { source: require("../../../public/maps/overlay/heading.png"), sdf: true } };

function viewOf(state: ViewStateChangeEvent): MapView {
  return { center: state.center, bounds: state.bounds, zoom: state.zoom };
}

export function MapSurface({ mapStyle, fallbackStyle, initialCamera, overlays = [], interactive = true, onUserGesture, onViewChanging, onViewChanged, onPress, ref }: MapSurfaceProps) {
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
      onRegionIsChanging={onViewChanging === undefined ? undefined : (event) => onViewChanging(viewOf(event.nativeEvent))}
      onRegionDidChange={(event) => onViewChanged?.(viewOf(event.nativeEvent))}
      onPress={onPress === undefined ? undefined : (event) => onPress(event.nativeEvent.lngLat)}
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
