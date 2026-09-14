export default function Skeleton({ height = 20 }: { height?: number }) {
    return <div className="fe-skeleton" style={{ height, marginBottom: 8 }} />;
}
