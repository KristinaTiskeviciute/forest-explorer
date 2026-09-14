import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LayerProvider } from "../lib/layers/layerStore";

const queryClient = new QueryClient();

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <QueryClientProvider client={queryClient}>
            <LayerProvider>{children}</LayerProvider>
        </QueryClientProvider>
    );
}
