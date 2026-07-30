import { useState } from 'react';
import { useSubmitLead } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';

export default function LeadGateway() {
  const [phone, setPhone] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [message, setMessage] = useState('');
  const [source, setSource] = useState('Test Gateway');

  const submitLead = useSubmitLead();

  const [lastResponse, setLastResponse] = useState<{
    status: number;
    intent: string;
    escalated: boolean;
    reply: string;
    booked_slot?: string | null;
  } | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    submitLead.mutate(
      {
        data: {
          phone_number: phone,
          first_name: firstName || undefined,
          last_name: lastName || undefined,
          source: source || undefined,
          message,
        },
      },
      {
        onSuccess: (response) => {
          setLastResponse(response);
        },
      }
    );
  };

  const resetForm = () => {
    setPhone('');
    setFirstName('');
    setLastName('');
    setMessage('');
    setSource('Test Gateway');
    setLastResponse(null);
    submitLead.reset();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-display font-bold tracking-tight">Lead Gateway</h1>
        <p className="text-muted-foreground mt-1">Test the BDC automation engine with sample leads</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Submit Test Lead</CardTitle>
            <CardDescription>Send a test message through the BDC pipeline</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="phone">Phone Number *</Label>
                <Input
                  id="phone"
                  type="tel"
                  placeholder="+1234567890"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  required
                  data-testid="input-phone"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="firstName">First Name</Label>
                  <Input
                    id="firstName"
                    placeholder="John"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    data-testid="input-first-name"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="lastName">Last Name</Label>
                  <Input
                    id="lastName"
                    placeholder="Doe"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    data-testid="input-last-name"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="source">Source</Label>
                <Input
                  id="source"
                  placeholder="Website, Walk-in, etc."
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  data-testid="input-source"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="message">Message *</Label>
                <Textarea
                  id="message"
                  placeholder="Hi, I'm interested in the 2024 Honda Civic..."
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  required
                  rows={5}
                  data-testid="input-message"
                />
              </div>

              <div className="flex gap-2">
                <Button type="submit" disabled={submitLead.isPending} data-testid="button-submit-lead">
                  {submitLead.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    'Submit Lead'
                  )}
                </Button>
                <Button type="button" variant="outline" onClick={resetForm} data-testid="button-reset">
                  Reset
                </Button>
              </div>

              {submitLead.error && (
                <div className="p-3 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                  Error: {submitLead.error.message || 'Failed to submit lead'}
                </div>
              )}
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Engine Response</CardTitle>
            <CardDescription>Real-time BDC bot analysis and reply</CardDescription>
          </CardHeader>
          <CardContent>
            {!lastResponse && !submitLead.isPending ? (
              <div className="text-center py-12 text-muted-foreground">
                Submit a lead to see the engine's response
              </div>
            ) : submitLead.isPending ? (
              <div className="text-center py-12">
                <Loader2 className="w-8 h-8 animate-spin mx-auto text-primary mb-2" />
                <p className="text-muted-foreground">Processing lead...</p>
              </div>
            ) : lastResponse ? (
              <div className="space-y-4" data-testid="response-container">
                <div>
                  <Label className="text-xs uppercase text-muted-foreground">Status Code</Label>
                  <div className="font-mono-data text-lg font-semibold mt-1" data-testid="response-status">
                    {lastResponse.status}
                  </div>
                </div>

                <div>
                  <Label className="text-xs uppercase text-muted-foreground">Detected Intent</Label>
                  <div className="mt-1">
                    <Badge variant="default" data-testid="response-intent">
                      {lastResponse.intent}
                    </Badge>
                  </div>
                </div>

                <div>
                  <Label className="text-xs uppercase text-muted-foreground">Escalated to Desk</Label>
                  <div className="mt-1">
                    <Badge variant={lastResponse.escalated ? 'destructive' : 'success'} data-testid="response-escalated">
                      {lastResponse.escalated ? 'YES' : 'NO'}
                    </Badge>
                  </div>
                </div>

                {lastResponse.booked_slot && (
                  <div>
                    <Label className="text-xs uppercase text-muted-foreground">Booked Slot</Label>
                    <div className="font-mono-data text-sm mt-1 font-semibold" data-testid="response-booked-slot">
                      {lastResponse.booked_slot}
                    </div>
                  </div>
                )}

                <div>
                  <Label className="text-xs uppercase text-muted-foreground">Bot Reply</Label>
                  <div
                    className="mt-2 p-4 rounded-md bg-muted/50 border border-border text-sm leading-relaxed"
                    data-testid="response-reply"
                  >
                    {lastResponse.reply}
                  </div>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
