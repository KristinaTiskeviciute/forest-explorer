export type YrForecast = {
    /** Instantaneous reading at request time — "what's it like right now" */
    temperature: number;
    humidity: number;
    /** Highest instant.air_temperature over the next 24h — a much better
     *  proxy for "how warm did/will it get" than a single instant reading.
     *  Still forward-looking (Locationforecast has no historical data);
     *  superseded by FrostObservation.tempMax72hObserved when available. */
    temperatureMax24hForecast: number;
    precipitation24h: number;
    /** Sum of forecast precipitation over the NEXT 72h (Locationforecast is
     *  a pure forecast product — it cannot report past rainfall). Named
     *  "Forecast" deliberately so it isn't mistaken for the backward-looking
     *  "has it already rained enough" signal that actually predicts fruiting
     *  — see FrostObservation.precipitation72hObserved for that. */
    precipitation72hForecast: number;
};

export function parseYrForecast(json: {
    properties: {
        timeseries: Array<{
            data: {
                instant: { details: { air_temperature: number; relative_humidity: number } };
                next_1_hours?: { details: { precipitation_amount: number } };
                next_6_hours?: { details: { precipitation_amount: number } };
            };
        }>;
    };
}): YrForecast {
    const timeseries = json.properties.timeseries;
    if (timeseries.length === 0) {
        throw new Error("Yr forecast response had an empty timeseries");
    }
    const current = timeseries[0].data.instant.details;

    const precip = (t: (typeof timeseries)[0]) =>
        t.data.next_1_hours?.details?.precipitation_amount ??
        (t.data.next_6_hours?.details?.precipitation_amount ?? 0) / 6;

    const next24h = timeseries.slice(0, 24);
    const precipitation24h = next24h.reduce((sum, t) => sum + precip(t), 0);
    const precipitation72hForecast = timeseries.slice(0, 72).reduce((sum, t) => sum + precip(t), 0);
    const temperatureMax24hForecast = next24h.reduce(
        (max, t) => Math.max(max, t.data.instant.details.air_temperature),
        current.air_temperature,
    );

    return {
        temperature: current.air_temperature,
        humidity: current.relative_humidity,
        temperatureMax24hForecast,
        precipitation24h,
        precipitation72hForecast,
    };
}
