import { useListAppointments, getListAppointmentsQueryKey } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';

export default function Appointments() {
  const { data, isLoading, error } = useListAppointments({
    query: {
      refetchInterval: 10000,
      queryKey: getListAppointmentsQueryKey(),
    },
  });

  const appointments = data?.appointments || [];

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Card className="max-w-md w-full mx-4">
          <CardContent className="pt-6">
            <p className="text-destructive text-center">Failed to load appointments. Please try again.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-display font-bold tracking-tight">Appointment Board</h1>
        <p className="text-muted-foreground mt-1">All booked appointments and test drives</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-2">
            <span>Booked Appointments</span>
            <Badge variant="outline" className="font-mono-data">
              {appointments.length} Total
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 sm:p-6 sm:pt-0">
          {isLoading ? (
            <div className="space-y-2 p-4 sm:p-0">
              {[...Array(8)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : appointments.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No appointments scheduled
            </div>
          ) : (
            <>
              {/* ── Mobile stacked cards (hidden on sm+) ── */}
              <div className="sm:hidden divide-y divide-border">
                {appointments.map((appt) => (
                  <div
                    key={appt.id}
                    data-testid={`appointment-row-${appt.id}`}
                    className="px-4 py-4 space-y-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-semibold text-sm">
                        {appt.first_name} {appt.last_name}
                      </div>
                      <Badge
                        variant={appt.status === 'CONFIRMED' ? 'success' : 'warning'}
                        data-testid={`status-${appt.id}`}
                        className="flex-shrink-0"
                      >
                        {appt.status}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="font-mono-data">{appt.phone_number}</span>
                      <Badge variant="outline" className="text-[10px]">{appt.appt_type}</Badge>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                      <span className="font-mono-data font-semibold">{appt.time_slot}</span>
                      {appt.active_stock_no && (
                        <span className="text-primary font-medium">Stock: {appt.active_stock_no}</span>
                      )}
                      {appt.trade_vehicle && (
                        <span className="text-muted-foreground">Trade: {appt.trade_vehicle}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* ── Desktop table (hidden below sm) ── */}
              <div className="hidden sm:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Customer</TableHead>
                      <TableHead>Phone</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Time Slot</TableHead>
                      <TableHead>Stock Interest</TableHead>
                      <TableHead>Trade Vehicle</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {appointments.map((appt) => (
                      <TableRow key={appt.id} data-testid={`appointment-row-${appt.id}`}>
                        <TableCell className="font-semibold">
                          {appt.first_name} {appt.last_name}
                        </TableCell>
                        <TableCell className="font-mono-data text-sm">{appt.phone_number}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {appt.appt_type}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono-data font-semibold">{appt.time_slot}</TableCell>
                        <TableCell>
                          {appt.active_stock_no ? (
                            <span className="text-primary font-medium">{appt.active_stock_no}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {appt.trade_vehicle ? (
                            <span className="text-sm">{appt.trade_vehicle}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={appt.status === 'CONFIRMED' ? 'success' : 'warning'}
                            data-testid={`status-${appt.id}`}
                          >
                            {appt.status}
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
