export const basemapStreet = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
  maxZoom: 19
});

export const basemapSatellite = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: '© <a href="https://www.esri.com">Esri</a>, Maxar, Earthstar Geographics',
  maxZoom: 19
});

export const basemapOcean = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}', {
  attribution: '© <a href="https://www.esri.com">Esri</a>, GEBCO, NOAA, National Geographic',
  maxZoom: 13
});

export const overlayNautical = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openseamap.org">OpenSeaMap</a>',
  maxZoom: 18,
  opacity: 0.9
});

export const overlayOceanRef = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}', {
  attribution: '© Esri',
  maxZoom: 13,
  opacity: 0.85
});

export const BASEMAPS = {
  'Street':             basemapStreet,
  'Satellite':          basemapSatellite,
  'Ocean / Bathymetry': basemapOcean,
};

export const DEFAULT_BASEMAP = basemapSatellite;
