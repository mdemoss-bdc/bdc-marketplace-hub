import { useListInventory, getListInventoryQueryKey } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { useState } from 'react';

export default function Inventory() {
  const [search, setSearch] = useState('');

  const { data, isLoading, error } = useListInventory({
    query: {
      queryKey: getListInventoryQueryKey(),
    },
  });

  const inventory = data?.inventory || [];

  const filteredInventory = inventory.filter((item) => {
    const searchLower = search.toLowerCase();
    return (
      item.stock_no.toLowerCase().includes(searchLower) ||
      item.make.toLowerCase().includes(searchLower) ||
      item.model.toLowerCase().includes(searchLower) ||
      item.year.toString().includes(searchLower) ||
      item.trim?.toLowerCase().includes(searchLower)
    );
  });

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Card className="max-w-md w-full mx-4">
          <CardContent className="pt-6">
            <p className="text-destructive text-center">Failed to load inventory. Please try again.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-display font-bold tracking-tight">Vehicle Inventory</h1>
        <p className="text-muted-foreground mt-1">Current stock and availability status</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-2">
            <span>Current Stock</span>
            <Badge variant="outline" className="font-mono-data">
              {filteredInventory.length} Vehicles
            </Badge>
          </CardTitle>
          <div className="mt-3">
            <Input
              type="search"
              placeholder="Search by stock no, make, model, year..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="input-search-inventory"
              className="w-full md:max-w-md h-11"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0 sm:p-6 sm:pt-0">
          {isLoading ? (
            <div className="space-y-2 p-4 sm:p-0">
              {[...Array(10)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filteredInventory.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              {search ? 'No vehicles match your search' : 'No inventory available'}
            </div>
          ) : (
            <>
              {/* ── Mobile stacked cards (hidden on sm+) ── */}
              <div className="sm:hidden divide-y divide-border">
                {filteredInventory.map((vehicle) => (
                  <div
                    key={vehicle.stock_no}
                    data-testid={`vehicle-row-${vehicle.stock_no}`}
                    className="px-4 py-4 space-y-1.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="font-mono-data font-semibold text-primary text-sm">
                          {vehicle.stock_no}
                        </span>
                        <span className="ml-2 font-semibold text-sm">
                          {vehicle.year} {vehicle.make} {vehicle.model}
                        </span>
                      </div>
                      <Badge
                        variant={vehicle.status === 'AVAILABLE' ? 'success' : 'secondary'}
                        data-testid={`status-${vehicle.stock_no}`}
                        className="flex-shrink-0 text-xs"
                      >
                        {vehicle.status}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {vehicle.trim && <span>{vehicle.trim}</span>}
                      {vehicle.body_style && (
                        <Badge variant="outline" className="text-[10px]">{vehicle.body_style}</Badge>
                      )}
                      <span className="font-mono-data font-semibold text-foreground">
                        {vehicle.price
                          ? vehicle.price
                          : vehicle.raw_price
                          ? `$${vehicle.raw_price.toLocaleString()}`
                          : '—'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* ── Desktop table (hidden below sm) ── */}
              <div className="hidden sm:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Stock No</TableHead>
                      <TableHead>Year</TableHead>
                      <TableHead>Make</TableHead>
                      <TableHead>Model</TableHead>
                      <TableHead>Trim</TableHead>
                      <TableHead>Body Style</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredInventory.map((vehicle) => (
                      <TableRow key={vehicle.stock_no} data-testid={`vehicle-row-${vehicle.stock_no}`}>
                        <TableCell className="font-mono-data font-semibold text-primary">
                          {vehicle.stock_no}
                        </TableCell>
                        <TableCell className="font-mono-data">{vehicle.year}</TableCell>
                        <TableCell className="font-semibold">{vehicle.make}</TableCell>
                        <TableCell>{vehicle.model}</TableCell>
                        <TableCell className="text-muted-foreground">{vehicle.trim || '—'}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {vehicle.body_style || '—'}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono-data font-semibold">
                          {vehicle.price
                            ? vehicle.price
                            : vehicle.raw_price
                            ? `$${vehicle.raw_price.toLocaleString()}`
                            : '—'}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={vehicle.status === 'AVAILABLE' ? 'success' : 'secondary'}
                            data-testid={`status-${vehicle.stock_no}`}
                          >
                            {vehicle.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
